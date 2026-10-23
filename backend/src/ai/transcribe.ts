// Groq speech-to-text: the browser uploads one VAD-delimited audio segment,
// we forward it to Groq's OpenAI-compatible transcription endpoint and return
// the text. The API key stays server-side.
//
// Latency notes: whisper-large-v3-turbo transcribes far faster than realtime,
// so the end-to-end delay is dominated by the upload + a short server hop. A
// 20s timeout and one bounded retry keep a stalled upstream from piling up
// queued segments; the shared semaphore/circuit breaker mirror translate.ts.

import { loadAiConfig } from "./config.js";
import {
  groqSemaphore,
  groqBreaker,
  parseRetryAfter,
  withRetry,
  type TranslateError,
} from "./resilience.js";

const GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const REQUEST_TIMEOUT_MS = 20_000;
/** Client segments are ~20s of opus (<1MB); anything bigger is a bug or abuse. */
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export type SttError = TranslateError;

function mapNetworkError(err: unknown): SttError {
  if (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return { status: 504, message: "transcription request timed out" };
  }
  return {
    status: 502,
    message: err instanceof Error ? err.message : "transcription request failed",
  };
}

/** Filename extension Groq expects for the browser's recorder mime type. */
function filenameFor(mime: string): string {
  if (mime.includes("mp4")) return "segment.mp4";
  if (mime.includes("ogg")) return "segment.ogg";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "segment.mp3";
  return "segment.webm";
}

/** One attempt against Groq (no retry). Throws SttError. */
async function fetchOnce(
  audio: Buffer,
  mime: string,
  language: string | undefined,
  cfg: Awaited<ReturnType<typeof loadAiConfig>>,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type: mime || "audio/webm" }), filenameFor(mime));
  form.append("model", cfg.groqSttModel);
  form.append("response_format", "json");
  form.append("temperature", "0");
  // ISO-639-1 only: "pt-br" must reach Groq as "pt". Pinning the language
  // avoids detection and improves both accuracy and latency.
  if (language) form.append("language", language.split("-")[0]!);

  let res: Response;
  try {
    res = await fetch(GROQ_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.groqApiKey}` },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw mapNetworkError(err);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw {
      status: res.status,
      message: `Groq error ${res.status}: ${body.slice(0, 200)}`,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    } satisfies SttError;
  }

  let data: { text?: unknown };
  try {
    data = (await res.json()) as { text?: unknown };
  } catch {
    throw { status: 502, message: "Groq returned an unreadable response" } satisfies SttError;
  }
  return typeof data.text === "string" ? data.text.trim() : "";
}

/**
 * Transcribe one audio segment (webm/mp4/ogg from MediaRecorder). `language`
 * is the spoken language's event code; it is authoritative (derived from the
 * publisher token/event by the route, never trusted from the client).
 *
 * Resilience: bounded concurrency, one retry on transient failures with
 * Retry-After honoured, and a circuit breaker that fails fast during a Groq
 * outage so the client hears about it immediately.
 */
export async function transcribeAudio(
  audio: Buffer,
  mime: string,
  language: string | undefined,
): Promise<string> {
  const cfg = await loadAiConfig();
  if (!cfg.groqApiKey) {
    throw { status: 400, message: "Groq API key not configured" } satisfies SttError;
  }
  if (audio.length === 0) {
    throw { status: 400, message: "empty audio" } satisfies SttError;
  }
  if (audio.length > MAX_AUDIO_BYTES) {
    throw { status: 413, message: "audio segment too large" } satisfies SttError;
  }

  groqBreaker.guard();
  try {
    const text = await withRetry(
      async () => {
        await groqSemaphore.acquire();
        try {
          groqBreaker.guard(); // re-check after waiting in the queue
          return await fetchOnce(audio, mime, language, cfg);
        } finally {
          groqSemaphore.release();
        }
      },
      // An audio post is idempotent, so one retry on transient errors is safe
      // and hides single hiccups without delaying captions noticeably.
      { maxAttempts: 2, baseMs: 400 },
    );
    groqBreaker.onSuccess();
    return text;
  } catch (err) {
    groqBreaker.onFailure(err as SttError);
    throw err;
  }
}
