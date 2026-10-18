import { loadAiConfig } from "./config.js";
import { pricingFor, recordUsage } from "./usage.js";
import {
  openRouterSemaphore,
  openRouterBreaker,
  parseRetryAfter,
  translationCache,
  withRetry,
  type TranslateError,
} from "./resilience.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

/**
 * System prompt for one translation. `glossary` is the event's list of terms
 * (newline separated). It is capped so a long list can never crowd out the
 * actual conversation.
 */
function systemPrompt(
  sourceName: string,
  targetName: string,
  glossary?: string,
): string {
  const base =
    `You are a professional simultaneous interpreter. Translate the user's text ` +
    `from ${sourceName} into ${targetName}. Output only the translation — no notes, ` +
    `no quotes, no source text. Preserve tone and meaning; keep it natural and concise.`;
  const terms = (glossary ?? "").trim().slice(0, 2000);
  if (!terms) return base;
  return (
    `${base}\n\nTerminology for this event — use these words exactly as given ` +
    `(names stay unchanged, translated terms use the stated wording):\n${terms}`
  );
}

function cacheKey(
  text: string,
  sourceName: string,
  targetName: string,
  glossary?: string,
): string {
  // The glossary is part of the key: after an edit, old translations must not
  // be served from the cache with the previous terminology.
  return `${sourceName}\u0000${targetName}\u0000${glossary ?? ""}\u0000${text}`;
}

/** Token counts OpenRouter reports for one request (0 when it reports none). */
export type TokenUsage = { promptTokens: number; completionTokens: number };

const REQUEST_TIMEOUT_MS = 60_000;

/** Abort when the client disconnects or the upstream stalls. */
function requestSignal(client?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return client ? AbortSignal.any([timeout, client]) : timeout;
}

function mapNetworkError(err: unknown, client?: AbortSignal): TranslateError {
  if (client?.aborted) {
    return { status: 499, message: "client disconnected" };
  }
  if (
    err instanceof DOMException &&
    (err.name === "TimeoutError" || err.name === "AbortError")
  ) {
    return { status: 504, message: "translation request timed out" };
  }
  return {
    status: 502,
    message: err instanceof Error ? err.message : "translation request failed",
  };
}

/** Fetch the SSE stream from OpenRouter once (no retry). Throws TranslateError. */
async function fetchOnce(
  messages: ChatMessage[],
  cfg: Awaited<ReturnType<typeof loadAiConfig>>,
  onDelta: (full: string) => void,
  clientSignal?: AbortSignal,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.openRouterApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        stream: true,
        // Asks OpenRouter to close the stream with a usage chunk; without it
        // there is no token count and therefore no cost estimate.
        stream_options: { include_usage: true },
        temperature: cfg.temperature,
        max_tokens: 1024,
      }),
      signal: requestSignal(clientSignal),
    });
  } catch (err) {
    throw mapNetworkError(err, clientSignal);
  }

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

  try {
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
            usage?: { prompt_tokens?: number; completion_tokens?: number };
          };
          const piece = parsed.choices?.[0]?.delta?.content;
          if (piece) {
            full += piece;
            onDelta(full);
          }
          if (parsed.usage && onUsage) {
            onUsage({
              promptTokens: parsed.usage.prompt_tokens ?? 0,
              completionTokens: parsed.usage.completion_tokens ?? 0,
            });
          }
        } catch {
          // Ignore keep-alive/comment lines and partial JSON.
        }
      }
    }
  } catch (err) {
    throw mapNetworkError(err, clientSignal);
  }

  return full;
}

export type { TranslateError };

/**
 * Stream a translation from OpenRouter (OpenAI-compatible SSE). `onDelta` fires
 * for each incremental token; the resolved value is the full translation.
 * `context` holds the last few prior translations for this target (continuity).
 *
 * `partialBaseline` is the previous translation of the same, still unfinished,
 * sentence. It is passed as an assistant prefill so the model continues the
 * rest instead of translating the whole sentence again.
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
  clientSignal?: AbortSignal,
  glossary?: string,
  eventId?: string,
  partialBaseline?: string,
): Promise<string> {
  const cfg = await loadAiConfig();
  if (!cfg.openRouterApiKey || !cfg.model) {
    throw { status: 400, message: "OpenRouter API key or model not configured" } satisfies TranslateError;
  }

  const key = cacheKey(text, sourceName, targetName, glossary);
  // A continuation must never be answered from the cache: the cached entry is a
  // whole-sentence translation and the client would prepend the baseline twice.
  const cached = partialBaseline ? undefined : translationCache.get(key);
  if (cached !== undefined) {
    onDelta(cached);
    return cached;
  }

  // Fail fast if the upstream is known to be down.
  openRouterBreaker.guard();

  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt(sourceName, targetName, glossary) },
  ];
  if (context.length > 0) {
    messages.push({
      role: "assistant",
      content: `Previous translations for continuity:\n${context.join("\n")}`,
    });
  }
  messages.push({ role: "user", content: text });

  // A partially spoken sentence gets the previous translation of the same
  // sentence as an assistant prefill, so the model continues from it instead of
  // restating it. The client compares the result with this prefix.
  if (partialBaseline && partialBaseline.trim()) {
    messages.push({ role: "assistant", content: partialBaseline });
  }

  let result: string;
  let usage: TokenUsage | null = null;
  try {
    result = await withRetry(async () => {
      await openRouterSemaphore.acquire();
      try {
        openRouterBreaker.guard(); // re-check after waiting in the queue
        return await fetchOnce(messages, cfg, onDelta, clientSignal, (u) => {
          usage = u;
        });
      } finally {
        openRouterSemaphore.release();
      }
    });
  } catch (err) {
    openRouterBreaker.onFailure(err as TranslateError);
    throw err;
  }

  openRouterBreaker.onSuccess();
  // A prefill is not a self-contained translation of `text`, and a partial
  // sentence is "cached" only for itself — neither belongs in the shared cache.
  if (result && !partialBaseline) translationCache.set(key, result);
  if (eventId && usage) {
    const u: TokenUsage = usage;
    void accountUsage(eventId, cfg.model, u);
  }
  return result;
}

/**
 * Record tokens for an event, with a cost estimate from the model's price.
 * Fire-and-forget: bookkeeping must never fail or delay a translation.
 */
async function accountUsage(
  eventId: string,
  modelId: string,
  usage: TokenUsage,
): Promise<void> {
  try {
    const price = await pricingFor(modelId);
    const cost = price
      ? usage.promptTokens * price.promptPerToken +
        usage.completionTokens * price.completionPerToken
      : 0;
    await recordUsage(eventId, usage.promptTokens, usage.completionTokens, cost);
  } catch (err) {
    console.error("[ai] could not record usage:", err);
  }
}
