import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { persistJsonAtomic, readJsonStore } from "../store.js";

/** STT engines the translator/operator UI knows how to drive. */
export const STT_ENGINES = ["web-speech", "groq"] as const;
export type SttEngine = (typeof STT_ENGINES)[number];

/** Whisper models Groq serves (see console.groq.com/docs/speech-to-text). */
export const GROQ_STT_MODELS = ["whisper-large-v3-turbo", "whisper-large-v3"] as const;
export type GroqSttModel = (typeof GROQ_STT_MODELS)[number];

export type AiConfig = {
  /** OpenRouter API key. Stays server-side; only ever returned masked. */
  openRouterApiKey: string;
  /** OpenRouter model id, e.g. "openai/gpt-4o-mini". */
  model: string;
  temperature: number;
  /** "web-speech" (browser) or "groq" (server-side Whisper via Groq). */
  sttEngine: string;
  /** Groq API key for speech-to-text. Stays server-side; returned masked. */
  groqApiKey: string;
  /** Groq Whisper model id used for transcription. */
  groqSttModel: string;
  /** Forward-compatible (phase 4): TTS provider for the server-side fallback. */
  ttsProvider: string;
};

const DEFAULTS: AiConfig = {
  openRouterApiKey: "",
  model: "",
  temperature: 0.3,
  sttEngine: "web-speech",
  groqApiKey: "",
  groqSttModel: "whisper-large-v3-turbo",
  ttsProvider: "edge",
};

const file = () => path.join(config.dataDir, "ai-config.json");
let cache: AiConfig | null = null;

/** Drop the in-memory cache (used by the admin data reset). */
export function resetAiConfigCache(): void {
  cache = null;
}

function envSeed(): Partial<AiConfig> {
  const seed: Partial<AiConfig> = {};
  if (process.env.OPENROUTER_API_KEY) seed.openRouterApiKey = process.env.OPENROUTER_API_KEY;
  if (process.env.OPENROUTER_MODEL) seed.model = process.env.OPENROUTER_MODEL;
  if (process.env.GROQ_API_KEY) seed.groqApiKey = process.env.GROQ_API_KEY;
  if (process.env.GROQ_STT_MODEL) seed.groqSttModel = process.env.GROQ_STT_MODEL;
  return seed;
}

async function persist(c: AiConfig): Promise<void> {
  await persistJsonAtomic(file(), c);
}

export async function loadAiConfig(): Promise<AiConfig> {
  if (cache) return cache;
  await fs.mkdir(config.dataDir, { recursive: true });
  // A torn ai-config.json must not take down the admin UI (and the AI relay):
  // fall back to the env seed and move the unreadable file aside.
  const stored = await readJsonStore<Partial<AiConfig> | null>(
    file(),
    (raw) => (raw && typeof raw === "object" ? (raw as Partial<AiConfig>) : null),
    null,
  );
  cache = { ...DEFAULTS, ...envSeed(), ...(stored ?? {}) };
  if (stored === null && (cache.openRouterApiKey || cache.model)) {
    await persist(cache).catch(() => undefined);
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
  if (typeof patch.groqApiKey === "string") next.groqApiKey = patch.groqApiKey;
  if (typeof patch.groqSttModel === "string") next.groqSttModel = patch.groqSttModel;
  if (typeof patch.ttsProvider === "string") next.ttsProvider = patch.ttsProvider;
  cache = next;
  try {
    await persist(next);
  } catch (err) {
    // Report the failure and keep the previous values: the admin UI must not
    // show a key/model that was never written to disk.
    cache = current;
    throw err;
  }
  return next;
}

/** Mask the API key for display: keep the last 4 chars, e.g. "…a1b2". */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 4) return "…";
  return "…" + key.slice(-4);
}
