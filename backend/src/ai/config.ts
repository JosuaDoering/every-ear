import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { persistJsonAtomic } from "../store.js";

export type AiConfig = {
  /** OpenRouter API key. Stays server-side; only ever returned masked. */
  openRouterApiKey: string;
  /** OpenRouter model id, e.g. "openai/gpt-4o-mini". */
  model: string;
  temperature: number;
  /** Forward-compatible (phase 5): "web-speech" | "whisper". */
  sttEngine: string;
  /** Forward-compatible (phase 4): TTS provider for the server-side fallback. */
  ttsProvider: string;
};

const DEFAULTS: AiConfig = {
  openRouterApiKey: "",
  model: "",
  temperature: 0.3,
  sttEngine: "web-speech",
  ttsProvider: "edge",
};

const file = () => path.join(config.dataDir, "ai-config.json");
let cache: AiConfig | null = null;

function envSeed(): Partial<AiConfig> {
  const seed: Partial<AiConfig> = {};
  if (process.env.OPENROUTER_API_KEY) seed.openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_MODEL) seed.model = process.env.OPENROUTER_MODEL;
  return seed;
}

async function persist(c: AiConfig): Promise<void> {
  await persistJsonAtomic(file(), c);
}

export async function loadAiConfig(): Promise<AiConfig> {
  if (cache) return cache;
  await fs.mkdir(config.dataDir, { recursive: true });
  try {
    const raw = await fs.readFile(file(), "utf8");
    cache = { ...DEFAULTS, ...(JSON.parse(raw) as Partial<AiConfig>) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      cache = { ...DEFAULTS, ...envSeed() };
      if (cache.openRouterApiKey || cache.model) await persist(cache);
    } else {
      throw err;
    }
  }
  return cache;
}

export async function updateAiConfig(patch: Partial<AiConfig>): Promise<AiConfig> {
  const current = await loadAiConfig();
  const next: AiConfig = { ...current };
  if (typeof patch.openRouterApiKey === "string") next.openRouterApiKey = patch.openRouterApiKey;
  if (typeof patch.model === "string") next.model = patch.model;
  if (typeof patch.temperature === "number" && Number.isFinite(patch.temperature)) {
    next.temperature = Math.min(2, Math.max(0, patch.temperature));
  }
  if (typeof patch.sttEngine === "string") next.sttEngine = patch.sttEngine;
  if (typeof patch.ttsProvider === "string") next.ttsProvider = patch.ttsProvider;
  cache = next;
  await persist(next);
  return next;
}

/** Mask the API key for display: keep the last 4 chars, e.g. "…a1b2". */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "…";
  return "…" + key.slice(-4);
}
