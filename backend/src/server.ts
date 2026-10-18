import Fastify from "fastify";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fastifyStatic from "@fastify/static";
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { ensureSettingsFile, getSettings, writeLivekitEnv } from "./settings.js";
import { writeCaddyfile, reloadCaddy } from "./caddy.js";
import {
  listenerToken,
  translatorToken,
  aiPublisherToken,
  verifyPublisherToken,
  type VerifiedPublisher,
} from "./tokens.js";
import { getCode, listCodes, markUsed } from "./codes.js";
import { getEvent, listActiveEvents, listEvents } from "./events.js";
import {
  getLanguage,
  listLanguages,
  validLanguage,
} from "./languages.js";
import { adminPlugin } from "./admin.js";
import { applySecurityHeaders } from "./security-headers.js";
import { registerBackgroundRoutes } from "./background.js";
import {
  startStatsCollector,
  isLiveKitReachable,
  handleWebhook,
} from "./stats.js";
import { startCertRenewal } from "./acme/renewal.js";
import { loadAiConfig } from "./ai/config.js";
import { translateStream, type TranslateError } from "./ai/translate.js";

/** Read a positive integer from the environment, falling back to `fallback`. */
function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
}

/**
 * Addresses allowed to set X-Forwarded-For. Only the local reverse proxy may,
 * otherwise any client could pick its own `req.ip` and sidestep the per-IP
 * rate limits (notably the 6-digit translator-code brute-force cap).
 */
function trustProxySetting(): true | string[] {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw === "true") return true;
  if (raw) return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return ["127.0.0.1", "::1"];
}

async function start() {
  // trustProxy so req.ip reflects the real client behind the Caddy reverse
  // proxy (via X-Forwarded-For) rather than 127.0.0.1. Timeouts bound resource
  // usage: a stalled client can't hold a connection or an in-flight request
  // open indefinitely, which matters under load on event WiFi.
  const app = Fastify({
    logger: true,
    trustProxy: trustProxySetting(),
    bodyLimit: 2 * 1024 * 1024,
    // Drop idle keep-alive sockets after 30s and force a connection-level
    // timeout so slow/stuck clients free up server resources.
    keepAliveTimeout: 30_000,
    connectionTimeout: 60_000,
    requestTimeout: 90_000,
  });

  // Same policy Caddy adds for the production static server, so the loopback
  // fallback UI (backend serves dist/ itself) is hardened too.
  app.addHook("onSend", async (_req, reply, payload) => {
    applySecurityHeaders(reply);
    return payload;
  });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  // LiveKit posts webhooks as `application/webhook+json`. The signature covers
  // the exact raw body, so parse it as a string and validate in the handler.
  app.addContentTypeParser(
    "application/webhook+json",
    { parseAs: "string" },
    (_req, body, done) => done(null, body),
  );

  // Global per-IP rate limit: a generous ceiling that protects against
  // runaway clients / accidental loops without throttling real event
  // traffic (hundreds of phones behind one NAT share a single upstream
  // IP — the limit is high on purpose). Stricter limits are applied per
  // route below. Tune via RATE_LIMIT_GLOBAL_MAX if a venue puts many guests
  // behind a second NAT/hotspot so they share one IP.
  await app.register(rateLimit, {
    max: envInt("RATE_LIMIT_GLOBAL_MAX", 600),
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

  // Readiness/liveness probe. Returns LiveKit reachability plus disk/data-dir
  // health so Caddy/Electron (or any orchestrator/watchdog) can distinguish
  // "backend up" from "stack ready" and from "about to fall over".
  app.get("/api/health", async () => {
    let diskFreeBytes: number | null = null;
    let diskFreePercent: number | null = null;
    let dataWritable = false;
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      await fs.access(config.dataDir);
      dataWritable = true;
    } catch {
      dataWritable = false;
    }
    try {
      const st = await fs.statfs(config.dataDir);
      diskFreeBytes = Number(st.bavail) * Number(st.bsize);
      const total = Number(st.blocks) * Number(st.bsize);
      diskFreePercent = total > 0 ? Math.round((diskFreeBytes / total) * 1000) / 10 : null;
    } catch {
      // statfs is unavailable on some platforms — leave the fields null.
    }
    return {
      status: "ok",
      livekit: isLiveKitReachable() ? "ok" : "unreachable",
      uptimeMs: process.uptime() * 1000,
      dataWritable,
      diskFreeBytes,
      diskFreePercent,
    };
  });

  // LiveKit pushes participant/track events here (see stats.ts). Excluded from
  // the global per-IP rate limit: a 600-listener join burst produces hundreds of
  // events from 127.0.0.1 in a minute, and dropping them would only cause the
  // stats to drift until the next reconciliation.
  app.post(
    "/api/livekit/webhook",
    { config: { rateLimit: false } },
    async (req, reply) => {
      const raw = typeof req.body === "string" ? req.body : "";
      if (!raw) return reply.code(400).send({ error: "empty body" });
      try {
        await handleWebhook(raw, req.headers.authorization);
        return { ok: true };
      } catch (err) {
        req.log.warn({ err }, "livekit webhook rejected");
        return reply.code(401).send({ error: "unauthorized" });
      }
    },
  );

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
    { config: { rateLimit: { max: envInt("RATE_LIMIT_LISTENER_MAX", 300), timeWindow: "1 minute" } } },
    async (req, reply) => {
      const eventId = req.body?.eventId?.trim();
      const language = req.body?.language?.toLowerCase();
      if (!eventId) return reply.code(400).send({ error: "eventId required" });
      if (!language || !(await validLanguage(language))) {
        return reply.code(400).send({ error: "unknown language" });
      }
      const event = await getEvent(eventId);
      // Deactivated events must not hand out tokens either: guests who already
      // have the link would otherwise keep listening after the admin stops it.
      if (!event || event.active === false) {
        return reply.code(404).send({ error: "event not found" });
      }
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
      // A deactivated event must not hand out new publisher tokens: existing
      // sessions end with the 6h TTL, and new logins get a clear 410 instead of
      // a token for a room nobody is serving.
      if (event.active === false) {
        return reply.code(410).send({ error: "event is not active" });
      }
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

      // The event may still exist while this language was removed from it (or
      // moved to the AI languages). Its code would otherwise keep minting a
      // publisher token for a room no listener page offers.
      if (!event.languages.includes(entry.language)) {
        return reply.code(410).send({ error: "language no longer offered by this event" });
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
    Headers: { authorization?: string };
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
    // A translation is billed per token against the server's key, and the
    // chunker never sends more than one sentence: cap the input so a valid
    // token cannot be used to push whole documents through the paid API.
    if (text.length > 1000) {
      return reply.code(413).send({ error: "text too long (max 1000 characters)" });
    }
    if (!sourceLang || !targetLang) {
      return reply.code(400).send({ error: "sourceLang and targetLang required" });
    }

    // Every translation is paid for with the server's OpenRouter key, so only
    // translators/AI operators of this event may spend it.
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "") ?? "";
    if (!bearer) return reply.code(401).send({ error: "authorization required" });
    let grant: VerifiedPublisher;
    try {
      grant = await verifyPublisherToken(bearer);
    } catch {
      return reply.code(401).send({ error: "invalid token" });
    }
    const event = await getEvent(grant.eventId);
    if (!event || event.active === false) {
      return reply.code(403).send({ error: "event not available" });
    }
    // Only AI-enabled events may translate, and only into their AI languages,
    // and only into the language the presented token was issued for.
    const aiLangs = (event.aiLanguages ?? []).map((l) => l.toLowerCase());
    if (!aiLangs.includes(targetLang)) {
      return reply.code(403).send({ error: "target language not enabled for AI" });
    }
    if (grant.language.toLowerCase() !== targetLang) {
      return reply.code(403).send({ error: "token not valid for target language" });
    }

    const [src, tgt] = await Promise.all([
      getLanguage(sourceLang),
      getLanguage(targetLang),
    ]);
    const sourceName = src?.name ?? sourceLang;
    const targetName = tgt?.name ?? targetLang;

    reply.hijack();
    const raw = reply.raw;
    let closed = false;
    const abort = new AbortController();
    raw.on("close", () => {
      closed = true;
      abort.abort();
    });
    raw.on("error", () => {
      closed = true;
      abort.abort();
    });
    raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    const send = (event: object) => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    };

    try {
      const full = await translateStream(
        text,
        sourceName,
        targetName,
        context,
        (delta) => {
          send({ delta });
        },
        abort.signal,
      );
      send({ done: true, text: full });
    } catch (err) {
      const e = err as TranslateError;
      send({ error: e?.message ?? "translation failed", status: e?.status ?? 500 });
    } finally {
      if (!raw.writableEnded) {
        try {
          raw.end();
        } catch {
          // ignore
        }
      }
    }
  });

  registerBackgroundRoutes(app);
  await app.register(adminPlugin, { prefix: "/api/admin" });

  // Serve the built web UI directly from the backend so the admin interface is
  // always reachable on the loopback port (http://127.0.0.1:<port>/), even if
  // Caddy or LiveKit are down or the LAN address changed.
  if (existsSync(config.frontendDist)) {
    await app.register(fastifyStatic, {
      root: config.frontendDist,
      prefix: "/",
      index: ["index.html"],
    });
    app.setNotFoundHandler((req, reply) => {
      // Only extension-less paths are client-side routes. Returning index.html
      // for a missing /assets/*.js or image would hand the browser a 200 with
      // the wrong MIME type, so a stale bundle fails confusingly instead of
      // surfacing a plain 404.
      const pathname = (req.url.split("?")[0] ?? "").replace(/\/+$/, "");
      // Every /api route is JSON. A bare "/api" or an unknown "/api/foo" must
      // therefore 404 as JSON too, not answer with the SPA shell.
      const isApi = pathname === "/api" || pathname.startsWith("/api/");
      const isPage =
        req.method === "GET" &&
        !isApi &&
        !/\.[a-z0-9]{1,8}$/i.test(pathname);
      if (isPage) return reply.type("text/html").sendFile("index.html");
      return reply.code(404).send({ error: "not found" });
    });
  }

  // Trigger the codes-file migration on boot so listeners can see the
  // auto-created default event without first hitting an admin route.
  await listCodes();

  // Seed/refresh the settings file and write the Caddyfile before accepting
  // traffic, so the launcher can start Caddy pointing at it.
  const settings = ensureSettingsFile();
  if (!settings.livekitApiKey || !settings.livekitApiSecret) {
    app.log.error(
      "LiveKit API key/secret missing — set them via the web admin or LIVEKIT_API_KEY/SECRET.",
    );
  }
  // Keep the systemd-readable LiveKit env in sync with the settings file, and
  // clear any stale restart marker (we just booted = the restart happened).
  writeLivekitEnv();
  await fs.rm(path.join(config.dataDir, ".restart-requested"), { force: true });
  writeCaddyfile();

  await app.listen({ port: config.port, host: "127.0.0.1" });

  // Reload Caddy if it's already up (best-effort; the file was written above).
  void reloadCaddy();

  // Begin polling LiveKit for per-channel listener/broadcast stats. Runs in the
  // background; failures (e.g. LiveKit not up yet) are retried on each tick.
  void startStatsCollector();

  // Keep Netcup-issued certificates fresh (boot check + periodic renewal).
  startCertRenewal();

  // Graceful shutdown: systemd (or Ctrl-C) sends SIGTERM. Stop accepting work,
  // drain in-flight requests, then exit so no event is disturbed mid-restart.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
    } catch (err) {
      app.log.error({ err }, "error during shutdown");
    }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Never die silently: log unexpected failures. An uncaught exception leaves the
// process in an undefined state, so we exit and let the supervisor/systemd
// restart us cleanly rather than risk serving listeners from a broken process.
process.on("unhandledRejection", (reason) => {
  console.error("[backend] unhandled rejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[backend] uncaught exception:", err);
  process.exit(1);
});
