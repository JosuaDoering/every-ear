// Per-channel listener + broadcast statistics.
//
// A "channel" is one LiveKit room (event + language). We track, per room:
//   - active listeners right now (hidden subscribe-only participants),
//   - unique listeners seen in the last 24 h,
//   - effective seconds a translator/AI track was live (unmuted audio).
//
// LiveKit pushes participant events to /api/livekit/webhook (configured via the
// LIVEKIT_WEBHOOK_* env vars), which lets us keep the "listeners right now"
// counter current without polling the full participant list every few seconds.
// A full reconciliation against the RoomService API runs less frequently as the
// source of truth, so missed/dropped webhooks self-heal. Counts survive restarts
// via stats.json.

import path from "node:path";
import {
  RoomServiceClient,
  TrackType,
  WebhookReceiver,
} from "livekit-server-sdk";
import { config } from "./config.js";
import { readJsonStore, writeAtomic } from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1000;
// How often we rebuild the authoritative counts from LiveKit. The webhook path
// keeps the live numbers fresh in between, so this can be infrequent — which
// matters because listParticipants() returns the full participant list per room.
const RECONCILE_MS = 30_000;
const PERSIST_TICK_MS = 30_000;
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

// Live snapshot: listener participant identities currently in each room. Rebuilt
// from scratch on every reconciliation and adjusted incrementally by webhooks.
const activeListenerIdentities = new Map<string, Set<string>>();

let client: RoomServiceClient | null = null;
let clientCredentials: { key: string; secret: string } | null = null;
let receiver: { key: string; secret: string; instance: WebhookReceiver } | null = null;
let timer: NodeJS.Timeout | null = null;
let persistTimer: NodeJS.Timeout | null = null;
let dirty = false;
let lastPersist = 0;
let persisting = false;
let reconciling = false;
// Tracks whether the most recent LiveKit reconcile succeeded — exposed via
// isLiveKitReachable() for the /api/health readiness probe.
let lastPollOk = false;

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
// so repeat connections from one client count once for the 24 h total. Anything
// that doesn't match (legacy identities) falls back to the whole identity.
function listenerKeyFromIdentity(identity: string): string {
  const rest = identity.slice("listener-".length);
  const dash = rest.indexOf("-");
  return dash > 0 ? rest.slice(0, dash) : rest;
}

function activeCount(room: string): number {
  return activeListenerIdentities.get(room)?.size ?? 0;
}

// Record the peak concurrent listeners for the current 5-minute history bucket.
function recordPeak(room: string, listeners: number): void {
  const now = Date.now();
  const bucket = String(Math.floor(now / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS);
  const rs = roomStat(room);
  const peak = Math.max(rs.history[bucket] ?? 0, listeners);
  if (rs.history[bucket] !== peak) {
    rs.history[bucket] = peak;
    dirty = true;
  }
}

async function load(): Promise<void> {
  // A corrupt stats.json only costs history, so it is moved aside and the
  // collector starts empty instead of aborting start-up.
  const parsed = await readJsonStore<Partial<StatsModel> | null>(
    statsFile(),
    (raw) => (raw && typeof raw === "object" ? (raw as Partial<StatsModel>) : null),
    null,
  );
  if (parsed?.rooms) {
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
}

async function persist(): Promise<void> {
  if (persisting) return;
  persisting = true;
  try {
    // Atomic write: a crash mid-write must not leave a torn stats.json.
    await writeAtomic(statsFile(), JSON.stringify(model));
    lastPersist = Date.now();
    dirty = false;
  } catch (err) {
    console.error("[stats] failed to write stats.json:", err);
  } finally {
    persisting = false;
  }
}

function persistIfDirty(): void {
  if (dirty && !persisting && Date.now() - lastPersist >= PERSIST_MIN_INTERVAL_MS) {
    void persist();
  }
}

function pruneOld(now: number): void {
  for (const [room, rs] of Object.entries(model.rooms)) {
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
    // Drop rooms that never carried data (auto-created rooms, test joins) so
    // stats.json doesn't accumulate empty room entries forever.
    if (
      Object.keys(rs.listeners).length === 0 &&
      Object.keys(rs.history).length === 0 &&
      rs.broadcastSeconds === 0
    ) {
      delete model.rooms[room];
      dirty = true;
    }
  }
}

/** Clear all statistics (used by the admin "reset data" action). */
export function resetStatsData(): void {
  for (const room of Object.keys(model.rooms)) delete model.rooms[room];
  activeListenerIdentities.clear();
  dirty = false;
}

/** RoomService client, rebuilt when the admin rotates the LiveKit credentials. */
function liveKitClient(): RoomServiceClient | null {
  const key = config.apiKey;
  const secret = config.apiSecret;
  if (!key || !secret) return null;
  if (
    !client ||
    clientCredentials?.key !== key ||
    clientCredentials?.secret !== secret
  ) {
    client = new RoomServiceClient(liveKitUrl(), key, secret);
    clientCredentials = { key, secret };
  }
  return client;
}

// Authoritative rebuild from the RoomService API. Cheap enough to run every
// RECONCILE_MS and corrects any drift from missed webhook events.
async function reconcile(): Promise<void> {
  if (!liveKitClient() || reconciling) return;
  reconciling = true;
  const now = Date.now();
  try {
    const lk = liveKitClient()!;
    const rooms = await lk.listRooms();
    const seen = new Set<string>();
    for (const room of rooms) {
      seen.add(room.name);
      const participants = await lk.listParticipants(room.name);
      const set = new Set<string>();
      let broadcasting = false;
      for (const p of participants) {
        if (p.identity.startsWith("listener-")) {
          set.add(p.identity);
          roomStat(room.name).listeners[listenerKeyFromIdentity(p.identity)] = now;
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
      activeListenerIdentities.set(room.name, set);
      recordPeak(room.name, set.size);
      if (broadcasting) {
        roomStat(room.name).broadcastSeconds += RECONCILE_MS / 1000;
        dirty = true;
      }
    }
    // Rooms that have aged out (empty past LiveKit's timeout) no longer count.
    for (const room of activeListenerIdentities.keys()) {
      if (!seen.has(room)) activeListenerIdentities.delete(room);
    }
    pruneOld(now);
    lastPollOk = true;
  } catch {
    // LiveKit may not be up yet, or briefly unreachable — try again next tick.
    lastPollOk = false;
  } finally {
    reconciling = false;
  }
}

// ---- Webhook handling ------------------------------------------------------

// A rotated credential must also take effect in the webhook verifier; cache it
// per key/secret pair instead of pinning whatever the process started with.
function webhookReceiver(): WebhookReceiver {
  const key = config.apiKey;
  const secret = config.apiSecret;
  if (!receiver || receiver.key !== key || receiver.secret !== secret) {
    receiver = { key, secret, instance: new WebhookReceiver(key, secret) };
  }
  return receiver.instance;
}

function addActiveListener(room: string, identity: string): void {
  let set = activeListenerIdentities.get(room);
  if (!set) {
    set = new Set();
    activeListenerIdentities.set(room, set);
  }
  if (set.has(identity)) return;
  set.add(identity);
  recordPeak(room, set.size);
  dirty = true;
}

function removeActiveListener(room: string, identity: string): void {
  const set = activeListenerIdentities.get(room);
  if (set?.delete(identity)) dirty = true;
}

/**
 * Validate and apply a LiveKit webhook. `rawBody` must be the exact POSTed
 * string (used to verify the signed payload). Throws if authentication fails.
 */
export async function handleWebhook(
  rawBody: string,
  authHeader: string | undefined,
): Promise<void> {
  const event = await webhookReceiver().receive(rawBody, authHeader);
  const room = event.room?.name;
  const identity = event.participant?.identity ?? "";
  if (!room || !identity.startsWith("listener-")) return;

  if (event.event === "participant_joined") {
    roomStat(room).listeners[listenerKeyFromIdentity(identity)] = Date.now();
    addActiveListener(room, identity);
  } else if (
    event.event === "participant_left" ||
    event.event === "participant_connection_aborted"
  ) {
    removeActiveListener(room, identity);
  }
}

/** True if the most recent LiveKit reconcile succeeded. Best-effort readiness signal. */
export function isLiveKitReachable(): boolean {
  return lastPollOk;
}

export async function startStatsCollector(): Promise<void> {
  await load();
  void reconcile();
  timer = setInterval(() => void reconcile(), RECONCILE_MS);
  timer.unref?.();
  // Webhook-driven updates set `dirty` between reconciliations; flush them.
  persistTimer = setInterval(persistIfDirty, PERSIST_TICK_MS);
  persistTimer.unref?.();
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
    activeListeners: activeCount(room),
    listeners24h,
    broadcastSeconds: rs ? Math.round(rs.broadcastSeconds) : 0,
    history,
  };
}
