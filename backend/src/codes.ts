import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { config } from "./config.js";
import { persistJsonAtomic, readJsonStore, once, forgetPending } from "./store.js";
import { ensureDefaultEvent } from "./events.js";

export type CodeRole = "translator" | "ai-operator";

export type Code = {
  code: string;
  eventId: string;
  /** Empty for ai-operator codes (they drive every AI language of the event). */
  language: string;
  name: string;
  role?: CodeRole;
  createdAt: string;
  lastUsedAt?: string;
};

const codesFile = () => path.join(config.dataDir, "codes.json");

let cache: Map<string, Code> | null = null;

/** Drop the in-memory cache (used by the admin data reset). */
export function resetCodesCache(): void {
  cache = null;
  forgetPending(codesFile());
}

async function load(): Promise<Map<string, Code>> {
  if (cache) return cache;
  // Concurrent callers share one read; otherwise each would build its own Map
  // and the last writer would silently drop the others' changes.
  return once(codesFile(), async () => {
    await fs.mkdir(config.dataDir, { recursive: true });
    const entries = await readJsonStore<Code[]>(
      codesFile(),
      (raw) => {
        if (!Array.isArray(raw)) throw new Error("codes.json is not an array");
        return raw as Code[];
      },
      [],
    );
    const next = new Map<string, Code>();
    let needsMigration = false;
    let defaultEventId: string | null = null;
    for (const c of entries) {
      if (!c.eventId) {
        if (!defaultEventId) defaultEventId = (await ensureDefaultEvent()).id;
        next.set(c.code, { ...c, eventId: defaultEventId });
        needsMigration = true;
      } else {
        next.set(c.code, c);
      }
    }
    cache = next;
    // Persist once the cache is set: persist() reads the cache, so calling it
    // before the assignment would rewrite the old (empty) state.
    if (needsMigration) await persist(next);
    return cache;
  });
}

async function persist(map: Map<string, Code>): Promise<void> {
  try {
    await persistJsonAtomic(codesFile(), Array.from(map.values()));
  } catch (err) {
    // The mutation is already applied in memory, so a failed write would keep
    // it visible until the next restart, where it silently disappears. Drop the
    // cache: the next read re-reads what is really stored.
    cache = null;
    forgetPending(codesFile());
    throw err;
  }
}

export async function listCodes(eventId?: string): Promise<Code[]> {
  const map = await load();
  let arr = Array.from(map.values());
  if (eventId) arr = arr.filter((c) => c.eventId === eventId);
  return arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getCode(code: string): Promise<Code | null> {
  const map = await load();
  return map.get(code) ?? null;
}

export async function createCode(
  eventId: string,
  language: string,
  name: string,
  role: CodeRole = "translator",
): Promise<Code> {
  const map = await load();
  let code: string;
  do {
    code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  } while (map.has(code));
  const entry: Code = {
    code,
    eventId,
    language: role === "ai-operator" ? "" : language,
    name: name.slice(0, 60),
    role,
    createdAt: new Date().toISOString(),
  };
  map.set(code, entry);
  await persist(map);
  return entry;
}

export async function revokeCode(code: string): Promise<boolean> {
  const map = await load();
  const ok = map.delete(code);
  if (ok) await persist(map);
  return ok;
}

export async function revokeCodesForEvent(eventId: string): Promise<number> {
  const map = await load();
  let removed = 0;
  for (const [k, v] of map) {
    if (v.eventId === eventId) {
      map.delete(k);
      removed++;
    }
  }
  if (removed > 0) await persist(map);
  return removed;
}

export async function markUsed(code: string): Promise<void> {
  const map = await load();
  const entry = map.get(code);
  if (!entry) return;
  entry.lastUsedAt = new Date().toISOString();
  await persist(map);
}
