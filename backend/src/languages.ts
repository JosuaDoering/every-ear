import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { persistJsonAtomic } from "./store.js";

export type LanguageEntry = { code: string; name: string; flag: string };

const DEFAULT_FLAGS: Record<string, string> = {
  en: "🇬🇧", de: "🇩🇪", fr: "🇫🇷", es: "🇪🇸", it: "🇮🇹",
  pt: "🇵🇹", nl: "🇳🇱", pl: "🇵🇱", ru: "🇷🇺", uk: "🇺🇦",
  tr: "🇹🇷", ar: "🇸🇦", zh: "🇨🇳", ja: "🇯🇵", ko: "🇰🇷",
  hi: "🇮🇳", id: "🇮🇩", th: "🇹🇭", vi: "🇻🇳", he: "🇮🇱",
  cs: "🇨🇿", sv: "🇸🇪", da: "🇩🇰", no: "🇳🇴", fi: "🇫🇮",
  hu: "🇭🇺", ro: "🇷🇴", bg: "🇧🇬", el: "🇬🇷", hr: "🇭🇷",
  sk: "🇸🇰", sr: "🇷🇸", sl: "🇸🇮", lt: "🇱🇹", lv: "🇱🇻",
  et: "🇪🇪", is: "🇮🇸", ga: "🇮🇪",
};

const file = () => path.join(config.dataDir, "languages.json");
let cache: Map<string, LanguageEntry> | null = null;

export function defaultFlagFor(code: string): string {
  return DEFAULT_FLAGS[code.toLowerCase()] ?? "🏳️";
}

export function normalizeCode(code: string): string {
  return code.trim().toLowerCase();
}

export function isValidCode(code: string): boolean {
  // 2-8 letters, optional region suffix (e.g. en, pt-br, zh-tw).
  return /^[a-z]{2,8}(-[a-z0-9]{1,8})?$/.test(code);
}

function envSeed(): LanguageEntry[] {
  const codes = (process.env.LANGUAGES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  let names: Record<string, string> = {};
  let flags: Record<string, string> = {};
  try {
    if (process.env.LANGUAGE_NAMES) names = JSON.parse(process.env.LANGUAGE_NAMES);
  } catch {}
  try {
    if (process.env.LANGUAGE_FLAGS) flags = JSON.parse(process.env.LANGUAGE_FLAGS);
  } catch {}
  return codes.map((code) => ({
    code,
    name: names[code] ?? code.toUpperCase(),
    flag: flags[code] ?? defaultFlagFor(code),
  }));
}

async function load(): Promise<Map<string, LanguageEntry>> {
  if (cache) return cache;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(file(), "utf8");
    const arr = JSON.parse(raw) as LanguageEntry[];
    cache = new Map(arr.map((l) => [l.code, l]));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = new Map(envSeed().map((l) => [l.code, l]));
      if (cache.size > 0) await persist(cache);
    } else {
      throw err;
    }
  }
  return cache;
}

async function persist(m: Map<string, LanguageEntry>): Promise<void> {
  await persistJsonAtomic(file(), Array.from(m.values()));
}

export async function listLanguages(): Promise<LanguageEntry[]> {
  const m = await load();
  return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getLanguage(code: string): Promise<LanguageEntry | null> {
  const m = await load();
  return m.get(normalizeCode(code)) ?? null;
}

export async function validLanguage(code: string): Promise<boolean> {
  const m = await load();
  return m.has(normalizeCode(code));
}

export async function languageCodeSet(): Promise<Set<string>> {
  const m = await load();
  return new Set(m.keys());
}

export async function addLanguage(
  code: string,
  name: string,
  flag?: string,
): Promise<LanguageEntry> {
  const norm = normalizeCode(code);
  if (!isValidCode(norm)) throw new Error("invalid language code");
  const m = await load();
  if (m.has(norm)) throw new Error("language exists");
  const entry: LanguageEntry = {
    code: norm,
    name: (name.trim() || norm.toUpperCase()).slice(0, 60),
    flag: (flag?.trim() || defaultFlagFor(norm)).slice(0, 16),
  };
  m.set(norm, entry);
  await persist(m);
  return entry;
}

export async function updateLanguage(
  code: string,
  patch: { name?: string; flag?: string },
): Promise<LanguageEntry | null> {
  const m = await load();
  const entry = m.get(normalizeCode(code));
  if (!entry) return null;
  if (patch.name !== undefined) {
    entry.name = (patch.name.trim() || entry.code.toUpperCase()).slice(0, 60);
  }
  if (patch.flag !== undefined) {
    entry.flag = (patch.flag.trim() || defaultFlagFor(entry.code)).slice(0, 16);
  }
  await persist(m);
  return entry;
}

export async function removeLanguage(code: string): Promise<boolean> {
  const m = await load();
  const ok = m.delete(normalizeCode(code));
  if (ok) await persist(m);
  return ok;
}
