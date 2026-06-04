import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import {
  languageCodeSet,
  listLanguages,
} from "./languages.js";

export type Event = {
  id: string;
  name: string;
  languages: string[];
  backgroundExt?: string;
  createdAt: string;
  active?: boolean;
};

const eventsFile = () => path.join(config.dataDir, "events.json");

let cache: Map<string, Event> | null = null;

function makeId(): string {
  return randomBytes(6).toString("hex");
}

async function load(): Promise<Map<string, Event>> {
  if (cache) return cache;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(eventsFile(), "utf8");
    const arr = JSON.parse(raw) as Event[];
    cache = new Map(arr.map((e) => [e.id, e]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = new Map();
    } else {
      throw err;
    }
  }
  return cache;
}

async function persist(map: Map<string, Event>): Promise<void> {
  const arr = Array.from(map.values());
  await fs.writeFile(eventsFile(), JSON.stringify(arr, null, 2));
}

export async function listEvents(): Promise<Event[]> {
  const map = await load();
  return Array.from(map.values()).sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
}

export async function getEvent(id: string): Promise<Event | null> {
  const map = await load();
  return map.get(id) ?? null;
}

export async function createEvent(
  name: string,
  languages: string[],
): Promise<Event> {
  const map = await load();
  let id: string;
  do {
    id = makeId();
  } while (map.has(id));
  const known = await languageCodeSet();
  const entry: Event = {
    id,
    name: name.slice(0, 80),
    languages: languages.filter((l) => known.has(l)),
    createdAt: new Date().toISOString(),
  };
  map.set(id, entry);
  await persist(map);
  return entry;
}

export async function updateEvent(
  id: string,
  patch: { name?: string; languages?: string[]; backgroundExt?: string | null; active?: boolean },
): Promise<Event | null> {
  const map = await load();
  const entry = map.get(id);
  if (!entry) return null;
  if (patch.name !== undefined) entry.name = patch.name.slice(0, 80);
  if (patch.languages !== undefined) {
    const known = await languageCodeSet();
    entry.languages = patch.languages.filter((l) => known.has(l));
  }
  if (patch.backgroundExt !== undefined) {
    if (patch.backgroundExt === null) delete entry.backgroundExt;
    else entry.backgroundExt = patch.backgroundExt;
  }
  if (patch.active !== undefined) entry.active = patch.active;
  await persist(map);
  return entry;
}

export async function listActiveEvents(): Promise<Event[]> {
  const all = await listEvents();
  return all.filter((e) => e.active !== false);
}

export async function deleteEvent(id: string): Promise<boolean> {
  const map = await load();
  const ok = map.delete(id);
  if (ok) await persist(map);
  return ok;
}

/**
 * Ensure at least one event exists. If events.json is empty but codes.json
 * has entries from before events were introduced, create a "Default" event
 * containing every configured language and return its id so callers can
 * migrate orphaned codes onto it.
 */
export async function ensureDefaultEvent(): Promise<Event> {
  const map = await load();
  if (map.size > 0) {
    return Array.from(map.values()).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )[0]!;
  }
  const fresh: Event = {
    id: makeId(),
    name: "Default",
    languages: (await listLanguages()).map((l) => l.code),
    createdAt: new Date().toISOString(),
  };
  map.set(fresh.id, fresh);
  await persist(map);
  return fresh;
}
