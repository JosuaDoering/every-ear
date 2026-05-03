import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

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

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function optionalJSON<T>(name: string, fallback: T): T {
  const raw = process.env[name];
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

const languages = required("LANGUAGES")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const names = optionalJSON<Record<string, string>>("LANGUAGE_NAMES", {});
const flags = optionalJSON<Record<string, string>>("LANGUAGE_FLAGS", {});

const languageList = languages.map((code) => ({
  code,
  name: names[code] ?? code.toUpperCase(),
  flag: flags[code] ?? DEFAULT_FLAGS[code] ?? "🏳️",
}));

const languageSet = new Set(languages);

export const config = {
  apiKey: required("LIVEKIT_API_KEY"),
  apiSecret: required("LIVEKIT_API_SECRET"),
  adminPassword: required("ADMIN_PASSWORD"),
  port: Number(process.env.BACKEND_PORT ?? 3000),
  dataDir: path.join(projectRoot, "backend", "data"),
  defaultBackgroundPath: path.join(projectRoot, "frontend", "public", "bg.jpg"),
  languages: languageList,
  roomFor: (code: string) => `lang-${code}`,
  validLanguage: (code: string) => languageSet.has(code),
};
