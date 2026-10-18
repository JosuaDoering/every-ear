// Per-event token and cost accounting for AI translation.
//
// OpenRouter bills per token. The admin page shows what each event consumed so
// an organiser can see the running cost instead of discovering it on the
// invoice. Numbers come from the `usage` object OpenRouter returns on the last
// stream chunk (`stream_options.include_usage`).
//
// Only counters are stored — never any transcript text.

import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { persistJsonAtomic, readJsonStore } from "../store.js";

export type UsageTotals = {
  /** Completed translation requests. */
  requests: number;
  promptTokens: number;
  completionTokens: number;
  /** Estimated spend in US dollars; 0 when the model price is unknown. */
  costUsd: number;
};

type UsageModel = {
  /** event id → totals. */
  events: Record<string, UsageTotals>;
};

const file = () => path.join(config.dataDir, "ai-usage.json");
let model: UsageModel | null = null;
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

/** Drop the in-memory cache (admin data reset). */
export function resetUsageCache(): void {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  model = null;
  dirty = false;
}

async function load(): Promise<UsageModel> {
  if (model) return model;
  await fs.mkdir(config.dataDir, { recursive: true });
  const stored = await readJsonStore<Partial<UsageModel> | null>(
    file(),
    (raw) => (raw && typeof raw === "object" ? (raw as Partial<UsageModel>) : null),
    null,
  );
  model = { events: stored?.events && typeof stored.events === "object" ? stored.events : {} };
  return model;
}

function normalize(t: Partial<UsageTotals> | undefined): UsageTotals {
  return {
    requests: Number(t?.requests) || 0,
    promptTokens: Number(t?.promptTokens) || 0,
    completionTokens: Number(t?.completionTokens) || 0,
    costUsd: Number(t?.costUsd) || 0,
  };
}

async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (!model || !dirty) return;
  dirty = false;
  await persistJsonAtomic(file(), model).catch((err) => {
    console.error("[ai-usage] could not persist usage:", err);
    dirty = true;
  });
}

/** Buffer a write: translation streams finish in bursts, not one write each. */
function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, 2000);
  flushTimer.unref?.();
}

export async function recordUsage(
  eventId: string,
  promptTokens: number,
  completionTokens: number,
  costUsd: number,
): Promise<void> {
  const m = await load();
  const totals = normalize(m.events[eventId]);
  totals.requests += 1;
  totals.promptTokens += Math.max(0, Math.round(promptTokens));
  totals.completionTokens += Math.max(0, Math.round(completionTokens));
  totals.costUsd += Math.max(0, costUsd);
  m.events[eventId] = totals;
  dirty = true;
  scheduleFlush();
}

export async function usageForEvent(eventId: string): Promise<UsageTotals> {
  const m = await load();
  return normalize(m.events[eventId]);
}

// ---- Model pricing --------------------------------------------------------

type Pricing = { promptPerToken: number; completionPerToken: number };
let pricing: { at: number; byModel: Map<string, Pricing> } | null = null;
const PRICING_TTL_MS = 60 * 60 * 1000;

function parsePrice(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * Per-token prices for a model id, from OpenRouter's public catalogue. Cached
 * for an hour; an unreachable catalogue only means the cost stays at 0 while
 * the token counters keep working.
 */
export async function pricingFor(modelId: string): Promise<Pricing | null> {
  if (!modelId) return null;
  if (!pricing || Date.now() - pricing.at > PRICING_TTL_MS) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as {
        data?: { id: string; pricing?: { prompt?: unknown; completion?: unknown } }[];
      };
      const byModel = new Map<string, Pricing>();
      for (const m of data.data ?? []) {
        byModel.set(m.id, {
          promptPerToken: parsePrice(m.pricing?.prompt),
          completionPerToken: parsePrice(m.pricing?.completion),
        });
      }
      pricing = { at: Date.now(), byModel };
    } catch (err) {
      console.error("[ai-usage] could not load model pricing:", err);
      if (!pricing) return null;
      // Keep serving the stale prices rather than dropping to zero.
    }
  }
  return pricing?.byModel.get(modelId) ?? null;
}
