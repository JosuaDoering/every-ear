// Per-channel listener + broadcast statistics.
//
// A "channel" is one LiveKit room (event + language). We poll the LiveKit
// server API on an interval and derive, per room:
//   - active listeners right now (hidden subscribe-only participants),
//   - unique listeners seen in the last 24 h,
//   - effective seconds a translator/AI track was live (unmuted audio).
//
// Polling (rather than webhooks) keeps this self-contained: the backend always
// runs on the same host as LiveKit, so no webhook URL/signature wiring is
// needed. Counts survive restarts via stats.json.

import { promises as fs } from "node:fs";
import path from "node:path";
import { RoomServiceClient, TrackType } from "livekit-server-sdk";
import { config } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const POLL_MS = 5_000;
const PERSIST_MIN_INTERVAL_MS = 30_000;
// Resolution of the "concurrent listeners over the last 24 h" history chart.
const HISTORY_BUCKET_MS = 5 * 60 * 1000;

type RoomStat = {
  /** Cumulative seconds at least one publisher had a live (unmuted) audio track. */
  broadcastSeconds: number;
  /** unique listener key (hashed IP) → last-seen epoch ms, for the 24 h count. */
  listeners: Record<string, number>;
  /** history bucket start (epoch ms, as string key) → peak concurrent listeners. */
  history: Record<string, number>;
};

type StatsModel = { rooms: Record<string, RoomStat> };

const statsFile = () => path.join(config.dataDir, "stats.json");

const model: StatsModel = { rooms: {} };
// Live snapshot from the most recent poll (not persisted — rebuilt on restart).
const activeListeners = new Map<string, number>();

let client: RoomServiceClient | null = null;
let timer: NodeJS.Timeout | null = null;
let dirty = false;
let lastPersist = 0;

function liveKitUrl(): string {
  return process.env.LIVEKIT_URL ?? "http://127.0.0.1:7880";
}

function roomStat(room: string): RoomStat {
  let rs = model.rooms[room];
  if (!rs) {
    rs = { broadcastSeconds: 0, listeners: {}, history: {} };
    model.rooms[room] = rs;
  }
  return rs;
}

// A listener identity is `listener-<ipKey>-<random>`. Collapse it to the ipKey
// so repeat connections from one client count once. Anything that doesn't match
// (legacy identities) falls back to the whole identity, so it's still counted.
function listenerKeyFromIdentity(identity: string): string {
  const rest = identity.slice("listener-".length);
  const dash = rest.indexOf("-");
  return dash > 0 ? rest.slice(0, dash) : rest;
}

async function load(): Promise<void> {
  try {
    const raw = await fs.readFile(statsFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StatsModel>;
    if (parsed && typeof parsed === "object" && parsed.rooms) {
      for (const [room, rs] of Object.entries(parsed.rooms)) {
        model.rooms[room] = {
          broadcastSeconds: Number(rs?.broadcastSeconds) || 0,
          listeners:
            rs?.listeners && typeof rs.listeners === "object" ? rs.listeners : {},
          history:
            rs?.history && typeof rs.history === "object" ? rs.history : {},
        };
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.error("[stats] failed to read stats.json:", err);
    }
  }
}

async function persist(): Promise<void> {
  try {
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(statsFile(), JSON.stringify(model));
    lastPersist = Date.now();
  } catch (err) {
    console.error("[stats] failed to write stats.json:", err);
  }
}

function pruneOld(now: number): void {
  for (const rs of Object.values(model.rooms)) {
    for (const [id, ts] of Object.entries(rs.listeners)) {
      if (now - ts > DAY_MS) {
        delete rs.listeners[id];
        dirty = true;
      }
    }
    for (const bucket of Object.keys(rs.history)) {
      if (now - Number(bucket) > DAY_MS) {
        delete rs.history[bucket];
        dirty = true;
      }
    }
  }
}

async function poll(): Promise<void> {
  if (!client) return;
  const now = Date.now();
  try {
    const rooms = await client.listRooms();
    const seen = new Set<string>();
    for (const room of rooms) {
      seen.add(room.name);
      const participants = await client.listParticipants(room.name);
      const uniqueListeners = new Set<string>();
      let broadcasting = false;
      for (const p of participants) {
        if (p.identity.startsWith("listener-")) {
          const key = listenerKeyFromIdentity(p.identity);
          uniqueListeners.add(key);
          roomStat(room.name).listeners[key] = now;
          dirty = true;
        } else if (
          p.identity.startsWith("translator-") ||
          p.identity.startsWith("ai-")
        ) {
          if (p.tracks.some((t) => t.type === TrackType.AUDIO && !t.muted)) {
            broadcasting = true;
          }
        }
      }
      const listeners = uniqueListeners.size;
      activeListeners.set(room.name, listeners);
      // Record the peak concurrent (unique) listeners for this 5-minute bucket.
      const bucket = String(Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS);
      const rs = roomStat(room.name);
      const peak = Math.max(rs.history[bucket] ?? 0, listeners);
      if (rs.history[bucket] !== peak) {
        rs.history[bucket] = peak;
        dirty = true;
      }
      if (broadcasting) {
        rs.broadcastSeconds += POLL_MS / 1000;
        dirty = true;
      }
    }
    // Rooms that have aged out (empty past LiveKit's timeout) report no
    // active listeners.
    for (const room of activeListeners.keys()) {
      if (!seen.has(room)) activeListeners.set(room, 0);
    }
    pruneOld(now);
    if (dirty && now - lastPersist >= PERSIST_MIN_INTERVAL_MS) {
      dirty = false;
      await persist();
    }
  } catch {
    // LiveKit may not be up yet, or briefly unreachable — try again next tick.
  }
}

export async function startStatsCollector(): Promise<void> {
  await load();
  client = new RoomServiceClient(liveKitUrl(), config.apiKey, config.apiSecret);
  void poll();
  timer = setInterval(() => void poll(), POLL_MS);
  timer.unref?.();
}

export type HistoryPoint = { t: number; n: number };

export type ChannelStat = {
  activeListeners: number;
  listeners24h: number;
  broadcastSeconds: number;
  /** Peak concurrent listeners per 5-minute bucket over the last 24 h, sorted. */
  history: HistoryPoint[];
};

export function statsForRoom(room: string): ChannelStat {
  const rs = model.rooms[room];
  const now = Date.now();
  const listeners24h = rs
    ? Object.values(rs.listeners).filter((ts) => now - ts <= DAY_MS).length
    : 0;
  const history = rs
    ? Object.entries(rs.history)
        .map(([t, n]) => ({ t: Number(t), n }))
        .filter((p) => now - p.t <= DAY_MS)
        .sort((a, b) => a.t - b.t)
    : [];
  return {
    activeListeners: activeListeners.get(room) ?? 0,
    listeners24h,
    broadcastSeconds: rs ? Math.round(rs.broadcastSeconds) : 0,
    history,
  };
}
