import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { config } from "./config.js";
import { ensureDefaultEvent } from "./events.js";

export type Code = {
  code: string;
  eventId: string;
  language: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
};

const codesFile = () => path.join(config.dataDir, "codes.json");

let cache: Map<string, Code> | null = null;

async function load(): Promise<Map<string, Code>> {
  if (cache) return cache;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(codesFile(), "utf8");
    const arr = JSON.parse(raw) as Array<Partial<Code> & { code: string; language: string; name: string; createdAt: string }>;
    let needsMigration = false;
    let defaultEventId: string | null = null;
    const entries: Code[] = [];
    for (const c of arr) {
      if (!c.eventId) {
        if (!defaultEventId) defaultEventId = (await ensureDefaultEvent()).id;
        entries.push({ ...c, eventId: defaultEventId } as Code);
        needsMigration = true;
      } else {
        entries.push(c as Code);
      }
    }
    cache = new Map(entries.map((c) => [c.code, c]));
    if (needsMigration) await persist(cache);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = new Map();
    } else {
      throw err;
    }
  }
  return cache;
}

async function persist(map: Map<string, Code>): Promise<void> {
  const arr = Array.from(map.values());
  await fs.writeFile(codesFile(), JSON.stringify(arr, null, 2));
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
): Promise<Code> {
  const map = await load();
  let code: string;
  do {
    code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  } while (map.has(code));
  const entry: Code = {
    code,
    eventId,
    language,
    name: name.slice(0, 60),
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
