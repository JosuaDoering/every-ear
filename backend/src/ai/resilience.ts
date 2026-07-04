// Resilience layer for outbound OpenRouter calls: bounded concurrency,
// retry with exponential backoff (honouring Retry-After), a circuit
// breaker to fail fast during sustained outages, and a small LRU result
// cache. Together these prevent unbounded in-flight requests when the
// upstream API is slower than the chunker producing work.

import { setTimeout as delay } from "node:timers/promises";

export type TranslateError = { status: number; message: string; retryAfterMs?: number };

function isRetryableStatus(status: number): boolean {
  // 429 = rate limit, 5xx = transient server/upstream errors.
  return status === 429 || (status >= 500 && status <= 599);
}

/** Parse a Retry-After header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(Math.max(secs, 0), 60) * 1000;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Concurrency limiter (counting semaphore). Caps simultaneous in-flight
// requests to OpenRouter so the Node event loop and the upstream rate limit
// are never overwhelmed by a burst of AI operators / languages.
// ---------------------------------------------------------------------------
export class Semaphore {
  private active = 0;
  private waiters: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }
  release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------------------
// Circuit breaker. After `threshold` consecutive failures it opens for
// `resetMs`, during which calls fail fast instead of piling onto a failing
// upstream. A single probe call is allowed in half-open state.
// ---------------------------------------------------------------------------
type BreakerState = "closed" | "open" | "half-open";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;

  constructor(
    private readonly threshold: number,
    private readonly resetMs: number,
  ) {}

  /** Throws if the circuit is open. Marks the start of a probe in half-open. */
  guard(): void {
    if (this.state === "open") {
      if (Date.now() - this.openedAt >= this.resetMs) {
        this.state = "half-open";
      } else {
        throw { status: 503, message: "translation circuit open (upstream unavailable)" } satisfies TranslateError;
      }
    }
  }

  onSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = "closed";
  }

  onFailure(err: TranslateError): void {
    // Only trip on retryable (transient) errors, not on 4xx client errors.
    if (!isRetryableStatus(err.status)) {
      return;
    }
    this.consecutiveFailures++;
    if (this.state === "half-open" || this.consecutiveFailures >= this.threshold) {
      this.trip();
    }
  }

  private trip(): void {
    this.state = "open";
    this.openedAt = Date.now();
  }

  get isOpen(): boolean {
    return this.state === "open";
  }
}

// ---------------------------------------------------------------------------
// Retry wrapper. Retries retryable errors with exponential backoff + jitter,
// honouring Retry-After when present. Non-retryable errors propagate.
// ---------------------------------------------------------------------------
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; baseMs?: number } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseMs = opts.baseMs ?? 500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const e = err as TranslateError;
      const retryable = typeof e?.status === "number" && isRetryableStatus(e.status);
      if (!retryable || attempt === maxAttempts) throw err;
      // Backoff: base * 2^(attempt-1) + jitter, capped at 10s; honour Retry-After.
      const exp = Math.min(baseMs * 2 ** (attempt - 1), 10_000);
      const jitter = Math.floor(Math.random() * 250);
      const wait = Math.min((e.retryAfterMs ?? 0) || exp + jitter, 30_000);
      await delay(wait);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Small LRU cache for completed translations. Keyed by source/target/text.
// A hit avoids any upstream call entirely — common when the operator
// re-speaks similar phrases or STT re-emits a near-identical cumulative tail.
// ---------------------------------------------------------------------------
export class LruCache<K, V> {
  private map = new Map<K, V>();
  constructor(private readonly max: number) {}

  get(key: K): V | undefined {
    if (!this.map.has(key)) return undefined;
    // Refresh recency by re-inserting (Map preserves insertion order).
    const value = this.map.get(key)!;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
}

// Shared instances, sized for a single host. Override via env for tuning.
export const openRouterSemaphore = new Semaphore(
  Math.max(1, Number(process.env.OPENROUTER_MAX_CONCURRENCY ?? 4)),
);
export const openRouterBreaker = new CircuitBreaker(
  Math.max(1, Number(process.env.OPENROUTER_BREAKER_THRESHOLD ?? 5)),
  Math.max(1_000, Number(process.env.OPENROUTER_BREAKER_RESET_MS ?? 30_000)),
);
export const translationCache = new LruCache<string, string>(200);
