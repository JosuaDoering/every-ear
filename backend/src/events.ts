import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { persistJsonAtomic } from "./store.js";
import {
  languageCodeSet,
  listLanguages,
} from "./languages.js";

export type Event = {
  id: string;
  name: string;
  languages: string[];
  /** Languages covered by AI translation (subtitles + TTS), disjoint from `languages`. */
  aiLanguages?: string[];
  /** Source language the AI operator speaks, transcribed before translation. */
  aiSourceLang?: string;
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
  await persistJsonAtomic(eventsFile(), Array.from(map.values()));
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
  aiLanguages: string[] = [],
  aiSourceLang?: string,
): Promise<Event> {
  const map = await load();
  let id: string;
  do {
    id = makeId();
  } while (map.has(id));
  const known = await languageCodeSet();
  const langs = languages.filter((l) => known.has(l));
  const aiLangs = aiLanguages
    .filter((l) => known.has(l))
    .filter((l) => !langs.includes(l));
  const entry: Event = {
    id,
    name: name.slice(0, 80),
    languages: langs,
    createdAt: new Date().toISOString(),
  };
  if (aiLangs.length > 0) entry.aiLanguages = aiLangs;
  if (aiSourceLang && known.has(aiSourceLang)) entry.aiSourceLang = aiSourceLang;
  map.set(id, entry);
  await persist(map);
  return entry;
}

export async function updateEvent(
  id: string,
  patch: {
    name?: string;
    languages?: string[];
    aiLanguages?: string[];
    aiSourceLang?: string | null;
    backgroundExt?: string | null;
    active?: boolean;
  },
): Promise<Event | null> {
  const map = await load();
  const entry = map.get(id);
  if (!entry) return null;
  if (patch.name !== undefined) entry.name = patch.name.slice(0, 80);
  const known =
    patch.languages !== undefined || patch.aiLanguages !== undefined
      ? await languageCodeSet()
      : null;
  if (patch.languages !== undefined && known) {
    entry.languages = patch.languages.filter((l) => known.has(l));
  }
  if (patch.aiLanguages !== undefined && known) {
    const aiLangs = patch.aiLanguages
      .filter((l) => known.has(l))
      .filter((l) => !entry.languages.includes(l));
    if (aiLangs.length > 0) entry.aiLanguages = aiLangs;
    else delete entry.aiLanguages;
  } else if (patch.languages !== undefined && entry.aiLanguages) {
    // Languages changed but aiLanguages didn't — drop any newly-overlapping code.
    const aiLangs = entry.aiLanguages.filter((l) => !entry.languages.includes(l));
    if (aiLangs.length > 0) entry.aiLanguages = aiLangs;
    else delete entry.aiLanguages;
  }
  if (patch.aiSourceLang !== undefined) {
    if (patch.aiSourceLang === null || patch.aiSourceLang === "") {
      delete entry.aiSourceLang;
    } else {
      entry.aiSourceLang = patch.aiSourceLang;
    }
  }
  if (patch.backgroundExt !== undefined) {
    if (patch.backgroundExt === null) delete entry.backgroundExt;
    else entry.backgroundExt = patch.backgroundExt;
  }
  if (patch.active !== undefined) entry.active = patch.active;
  await persist(map);
  return entry;
}

/** Strip a language code from every event's `languages` and `aiLanguages`. */
export async function stripLanguageFromEvents(code: string): Promise<void> {
  const map = await load();
  let changed = false;
  for (const ev of map.values()) {
    if (ev.languages.includes(code)) {
      ev.languages = ev.languages.filter((c) => c !== code);
      changed = true;
    }
    if (ev.aiLanguages?.includes(code)) {
      const next = ev.aiLanguages.filter((c) => c !== code);
      if (next.length > 0) ev.aiLanguages = next;
      else delete ev.aiLanguages;
      changed = true;
    }
    if (ev.aiSourceLang === code) {
      delete ev.aiSourceLang;
      changed = true;
    }
  }
  if (changed) await persist(map);
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
