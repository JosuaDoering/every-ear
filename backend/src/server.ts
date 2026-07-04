import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { config } from "./config.js";
import { listenerToken, translatorToken, aiPublisherToken } from "./tokens.js";
import { getCode, listCodes, markUsed } from "./codes.js";
import { getEvent, listActiveEvents, listEvents } from "./events.js";
import {
  getLanguage,
  listLanguages,
  validLanguage,
} from "./languages.js";
import { adminPlugin } from "./admin.js";
import { registerBackgroundRoutes } from "./background.js";
import { startStatsCollector, isLiveKitReachable } from "./stats.js";
import { loadAiConfig } from "./ai/config.js";
import { translateStream, type TranslateError } from "./ai/translate.js";

async function start() {
  // trustProxy so req.ip reflects the real client behind the Caddy reverse
  // proxy (via X-Forwarded-For) rather than 127.0.0.1. Timeouts bound resource
  // usage: a stalled client can't hold a connection or an in-flight request
  // open indefinitely, which matters under load on event WiFi.
  const app = Fastify({
    logger: true,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    // Drop idle keep-alive sockets after 30s and force a connection-level
    // timeout so slow/stuck clients free up server resources.
    keepAliveTimeout: 30_000,
    connectionTimeout: 60_000,
    requestTimeout: 90_000,
  });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // Global per-IP rate limit: a generous ceiling that protects against
  // runaway clients / accidental loops without throttling real event
  // traffic (hundreds of phones behind one NAT share a single upstream
  // IP — the limit is high on purpose). Stricter limits are applied per
  // route below.
  await app.register(rateLimit, {
    max: 600,
    timeWindow: "1 minute",
    // Allow the shared LAN IP to burst during join surges at the start of
    // an event; the per-route caps below still bound the expensive paths.
    ban: 0,
    addHeaders: {
      "x-ratelimit-limit": true,
      "x-ratelimit-remaining": true,
      "x-ratelimit-reset": true,
      "retry-after": true,
    },
  });

  // Readiness/liveness probe. Returns LiveKit reachability so Caddy/Electron
  // (or any orchestrator) can distinguish "backend up" from "stack ready".
  app.get("/api/health", async () => {
    return {
      status: "ok",
      livekit: isLiveKitReachable() ? "ok" : "unreachable",
      uptimeMs: process.uptime() * 1000,
    };
  });

  app.get("/api/languages", async () => ({
    languages: await listLanguages(),
  }));

  app.get("/api/events", async () => {
    const [events, langs, allCodes] = await Promise.all([
      listActiveEvents(),
      listLanguages(),
      listCodes(),
    ]);
    const byCode = new Map(langs.map((l) => [l.code, l]));
    const eventIdsWithCodes = new Set(allCodes.map((c) => c.eventId));
    return {
      events: events
        .filter((e) => eventIdsWithCodes.has(e.id))
        .map((e) => {
          const human = e.languages
            .map((c) => byCode.get(c))
            .filter((l): l is (typeof langs)[number] => Boolean(l))
            .map((l) => ({ ...l, ai: false }));
          const ai = (e.aiLanguages ?? [])
            .map((c) => byCode.get(c))
            .filter((l): l is (typeof langs)[number] => Boolean(l))
            .map((l) => ({ ...l, ai: true }));
          return {
            id: e.id,
            name: e.name,
            // AI languages are "just another language" for listeners.
            languages: [...human, ...ai],
            hasBackground: Boolean(e.backgroundExt),
          };
        }),
    };
  });

  app.post<{ Body: { eventId?: string; language?: string } }>(
    "/api/token/listener",
    { config: { rateLimit: { max: 300, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const eventId = req.body?.eventId?.trim();
      const language = req.body?.language?.toLowerCase();
      if (!eventId) return reply.code(400).send({ error: "eventId required" });
      if (!language || !(await validLanguage(language))) {
        return reply.code(400).send({ error: "unknown language" });
      }
      const event = await getEvent(eventId);
      if (!event) return reply.code(404).send({ error: "event not found" });
      const eventLangs = [...event.languages, ...(event.aiLanguages ?? [])];
      if (!eventLangs.includes(language)) {
        return reply.code(400).send({ error: "language not in event" });
      }
      const token = await listenerToken(eventId, language, req.ip);
      return { token, room: config.roomFor(eventId, language) };
    },
  );

  app.post<{ Body: { code?: string } }>(
    "/api/token/translator",
    // Tight limit: a 6-digit code is brute-forceable, so cap attempts per IP.
    // Legitimate use is a handful of logins per minute at most.
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const code = req.body?.code?.trim();
      if (!code || !/^\d{6}$/.test(code)) {
        return reply.code(400).send({ error: "code must be 6 digits" });
      }
      const entry = await getCode(code);
      if (!entry) return reply.code(404).send({ error: "code not found" });
      const event = await getEvent(entry.eventId);
      if (!event) return reply.code(410).send({ error: "event no longer exists" });
      const aiCfg = await loadAiConfig();

      if (entry.role === "ai-operator") {
        const codes = event.aiLanguages ?? [];
        const aiLanguages: {
          code: string;
          name: string;
          flag: string;
          room: string;
          token: string;
        }[] = [];
        for (const c of codes) {
          const lang = await getLanguage(c);
          if (!lang) continue;
          aiLanguages.push({
            code: c,
            name: lang.name,
            flag: lang.flag,
            room: config.roomFor(event.id, c),
            token: await aiPublisherToken(event.id, c, entry.name),
          });
        }
        await markUsed(code);
        return {
          role: "ai-operator" as const,
          name: entry.name,
          eventId: event.id,
          eventName: event.name,
          eventHasBackground: Boolean(event.backgroundExt),
          sourceLang: event.aiSourceLang ?? "",
          sttEngine: aiCfg.sttEngine,
          aiLanguages,
        };
      }

      const lang = await getLanguage(entry.language);
      if (!lang) {
        return reply.code(410).send({ error: "language no longer configured" });
      }
      const token = await translatorToken(entry.eventId, entry.language, entry.name);
      await markUsed(code);
      return {
        role: "translator" as const,
        token,
        room: config.roomFor(entry.eventId, entry.language),
        language: entry.language,
        languageName: lang.name,
        flag: lang.flag,
        name: entry.name,
        eventId: event.id,
        eventName: event.name,
        eventHasBackground: Boolean(event.backgroundExt),
        sttEngine: aiCfg.sttEngine,
      };
    },
  );

  // ---- AI translation (SSE stream) -----------------------------------------

  app.post<{
    Body: { text?: string; sourceLang?: string; targetLang?: string; context?: string[] };
  }>("/api/ai/translate",
    // The shared concurrency limiter / circuit breaker in translate.ts is the
    // real guard against OpenRouter overload; this per-IP cap just stops a
    // single runaway client from flooding the queue. Generous enough for a
    // multi-language AI operator (~6 req/s sustained).
    { config: { rateLimit: { max: 600, timeWindow: "1 minute" } } },
    async (req, reply) => {
    const text = req.body?.text?.trim();
    const sourceLang = req.body?.sourceLang?.toLowerCase();
    const targetLang = req.body?.targetLang?.toLowerCase();
    const context = Array.isArray(req.body?.context)
      ? req.body!.context.filter((c): c is string => typeof c === "string").slice(-3)
      : [];
    if (!text) return reply.code(400).send({ error: "text required" });
    if (!sourceLang || !targetLang) {
      return reply.code(400).send({ error: "sourceLang and targetLang required" });
    }
    const [src, tgt] = await Promise.all([
      getLanguage(sourceLang),
      getLanguage(targetLang),
    ]);
    const sourceName = src?.name ?? sourceLang;
    const targetName = tgt?.name ?? targetLang;

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: object) => raw.write(`data: ${JSON.stringify(event)}\n\n`);

    try {
      const full = await translateStream(text, sourceName, targetName, context, (delta) => {
        send({ delta });
      });
      send({ done: true, text: full });
    } catch (err) {
      const e = err as TranslateError;
      send({ error: e?.message ?? "translation failed", status: e?.status ?? 500 });
    } finally {
      raw.end();
    }
  });

  registerBackgroundRoutes(app);
  await app.register(adminPlugin, { prefix: "/api/admin" });

  // Trigger the codes-file migration on boot so listeners can see the
  // auto-created default event without first hitting an admin route.
  await listCodes();

  await app.listen({ port: config.port, host: "127.0.0.1" });

  // Begin polling LiveKit for per-channel listener/broadcast stats. Runs in the
  // background; failures (e.g. LiveKit not up yet) are retried on each tick.
  void startStatsCollector();
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
