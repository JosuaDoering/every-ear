import { promises as fs } from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { config } from "./config.js";

export type Code = {
  code: string;
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
    const arr = JSON.parse(raw) as Code[];
    cache = new Map(arr.map((c) => [c.code, c]));
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

export async function listCodes(): Promise<Code[]> {
  const map = await load();
  return Array.from(map.values()).sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt),
  );
}

export async function getCode(code: string): Promise<Code | null> {
  const map = await load();
  return map.get(code) ?? null;
}

export async function createCode(language: string, name: string): Promise<Code> {
  const map = await load();
  let code: string;
  do {
    code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  } while (map.has(code));
  const entry: Code = {
    code,
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

export async function markUsed(code: string): Promise<void> {
  const map = await load();
  const entry = map.get(code);
  if (!entry) return;
  entry.lastUsedAt = new Date().toISOString();
  await persist(map);
}
