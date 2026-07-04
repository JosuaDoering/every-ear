import { loadAiConfig } from "./config.js";
import {
  openRouterSemaphore,
  openRouterBreaker,
  translationCache,
  withRetry,
  type TranslateError,
} from "./resilience.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

function systemPrompt(sourceName: string, targetName: string): string {
  return (
    `You are a professional simultaneous interpreter. Translate the user's text ` +
    `from ${sourceName} into ${targetName}. Output only the translation — no notes, ` +
    `no quotes, no source text. Preserve tone and meaning; keep it natural and concise.`
  );
}

function cacheKey(text: string, sourceName: string, targetName: string): string {
  return `${sourceName}\u0000${targetName}\u0000${text}`;
}

/** Fetch the SSE stream from OpenRouter once (no retry). Throws TranslateError. */
async function fetchOnce(
  messages: ChatMessage[],
  cfg: Awaited<ReturnType<typeof loadAiConfig>>,
  onDelta: (full: string) => void,
): Promise<string> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.openRouterApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream: true,
      temperature: cfg.temperature,
      max_tokens: 1024,
    }),
  });

  if (!res.ok || !res.body) {
    const body = await res.text().catch(() => "");
    const err: TranslateError = {
      status: res.status,
      message: `OpenRouter error ${res.status}: ${body.slice(0, 200)}`,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    };
    throw err;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data) as {
          choices?: { delta?: { content?: string } }[];
        };
        const piece = parsed.choices?.[0]?.delta?.content;
        if (piece) {
          full += piece;
          onDelta(full);
        }
      } catch {
        // Ignore keep-alive/comment lines and partial JSON.
      }
    }
  }

  return full;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 60) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return undefined;
}

export type { TranslateError };

/**
 * Stream a translation from OpenRouter (OpenAI-compatible SSE). `onDelta` fires
 * for each incremental token; the resolved value is the full translation.
 * `context` holds the last few prior translations for this target (continuity).
 *
 * Resilience: bounded concurrency (shared semaphore), retry with backoff +
 * Retry-After on transient errors, a circuit breaker that fails fast during
 * sustained outages, and a small LRU result cache for identical inputs.
 */
export async function translateStream(
  text: string,
  sourceName: string,
  targetName: string,
  context: string[],
  onDelta: (full: string) => void,
): Promise<string> {
  const cfg = await loadAiConfig();
  if (!cfg.openRouterApiKey || !cfg.model) {
    throw { status: 400, message: "OpenRouter API key or model not configured" } satisfies TranslateError;
  }

  const key = cacheKey(text, sourceName, targetName);
  const cached = translationCache.get(key);
  if (cached !== undefined) {
    onDelta(cached);
    return cached;
  }

  // Fail fast if the upstream is known to be down.
  openRouterBreaker.guard();

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(sourceName, targetName) },
  ];
  if (context.length > 0) {
    messages.push({
      role: "assistant",
      content: `Previous translations for continuity:\n${context.join("\n")}`,
    });
  }
  messages.push({ role: "user", content: text });

  let result: string;
  try {
    result = await withRetry(async () => {
      await openRouterSemaphore.acquire();
      try {
        openRouterBreaker.guard(); // re-check after waiting in the queue
        return await fetchOnce(messages, cfg, onDelta);
      } finally {
        openRouterSemaphore.release();
      }
    });
  } catch (err) {
    openRouterBreaker.onFailure(err as TranslateError);
    throw err;
  }

  openRouterBreaker.onSuccess();
  if (result) translationCache.set(key, result);
  return result;
}
