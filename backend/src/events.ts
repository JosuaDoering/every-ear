import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { persistJsonAtomic, readJsonStore, once, forgetPending } from "./store.js";
import {
  languageCodeSet,
  listLanguages,
} from "./languages.js";

/** Longest accepted event name (enforced by the admin API, not truncated). */
export const EVENT_NAME_MAX = 80;
/** Longest accepted glossary text (newline-separated entries). */
export const EVENT_GLOSSARY_MAX = 4000;

export type Event = {
  id: string;
  name: string;
  languages: string[];
  /** Languages covered by AI translation (subtitles + TTS), disjoint from `languages`. */
  aiLanguages?: string[];
  /** Source language the AI operator speaks, transcribed before translation. */
  aiSourceLang?: string;
  /**
   * Newline-separated terms with the wording the translator must use, e.g.
   * "Every Ear = Every Ear" or "Synode => Synod". Fed to the model as context.
   */
  glossary?: string;
  backgroundExt?: string;
  createdAt: string;
  active?: boolean;
};

const eventsFile = () => path.join(config.dataDir, "events.json");

let cache: Map<string, Event> | null = null;

/** Drop the in-memory cache (used by the admin data reset). */
export function resetEventsCache(): void {
  cache = null;
  forgetPending(eventsFile());
}

function makeId(): string {
  return randomBytes(6).toString("hex");
}

async function load(): Promise<Map<string, Event>> {
  if (cache) return cache;
  // Concurrent callers share one read; otherwise each would build its own Map
  // and the last writer would silently drop the others' changes.
  return once(eventsFile(), async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    const arr = await readJsonStore<Event[]>(
      eventsFile(),
      (raw) => {
        if (!Array.isArray(raw)) throw new Error("events.json is not an array");
        return raw as Event[];
      },
      [],
    );
    cache = new Map(arr.filter((e) => e && typeof e.id === "string").map((e) => [e.id, e]));
    return cache;
  });
}

async function persist(map: Map<string, Event>): Promise<void> {
  try {
    await persistJsonAtomic(eventsFile(), Array.from(map.values()));
  } catch (err) {
    // The mutation is already applied in memory, so a failed write would keep
    // it visible until the next restart, where it silently disappears. Drop the
    // cache: the next read re-reads what is really stored.
    cache = null;
    forgetPending(eventsFile());
    throw err;
  }
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
    name: name.slice(0, EVENT_NAME_MAX),
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
    glossary?: string | null;
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
      // An unknown code would silently produce translations from a language the
      // STT engine does not support, so reject it the same way as the create path.
      const knownLang = known ?? (await languageCodeSet());
      const normalized = patch.aiSourceLang.trim().toLowerCase();
      if (!knownLang.has(normalized)) {
        throw new Error(`unknown aiSourceLang: ${patch.aiSourceLang}`);
      }
      entry.aiSourceLang = normalized;
    }
  }
  if (patch.glossary !== undefined) {
    const text = (patch.glossary ?? "").trim();
    if (text) entry.glossary = text.slice(0, EVENT_GLOSSARY_MAX);
    else delete entry.glossary;
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
