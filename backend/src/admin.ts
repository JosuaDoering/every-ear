import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { promises as fs } from "node:fs";
import { createHash, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { config } from "./config.js";
import {
  createCode,
  listCodes,
  revokeCode,
  revokeCodesForEvent,
} from "./codes.js";
import {
  BACKGROUND_OUTPUT_EXT,
  clearEventBackground,
  clearGlobalBackground,
  readBackgroundUpload,
} from "./background.js";
import {
  createEvent,
  deleteEvent,
  ensureDefaultEvent,
  EVENT_GLOSSARY_MAX,
  EVENT_NAME_MAX,
  getEvent,
  listEvents,
  stripLanguageFromEvents,
  updateEvent,
} from "./events.js";
import {
  addLanguage,
  listLanguages,
  normalizeCode,
  removeLanguage,
  updateLanguage,
  validLanguage,
} from "./languages.js";
import { loadAiConfig, updateAiConfig, maskKey } from "./ai/config.js";
import { usageForEvent } from "./ai/usage.js";
import { statsForRoom } from "./stats.js";
import { settingsApiPlugin } from "./settings-api.js";

function constantTimeEqual(a: string, b: string): boolean {
  // Hash first: comparing the raw strings would return early on a length
  // mismatch, which leaks the password length to a timing attacker.
  const left = createHash("sha256").update(a).digest();
  const right = createHash("sha256").update(b).digest();
  return timingSafeEqual(left, right);
}

function authorized(header: string | undefined): boolean {
  // Fail closed: if the configured password is missing/empty (e.g. a corrupt or
  // legacy settings file), the admin API must never be accessible anonymously.
  const expected = config.adminPassword;
  if (!expected) return false;
  if (!header || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7).trim(), expected);
}

export const adminPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Stricter rate limit than the global one for every admin route: the admin
  // password is a bearer token, so cap brute-force attempts per IP. The global
  // limiter (root scope) is far too generous for an authenticated surface.
  app.addHook("onRoute", (routeOptions) => {
    routeOptions.config = {
      ...(routeOptions.config ?? {}),
      rateLimit: { max: 60, timeWindow: "1 minute" },
    };
  });

  app.addHook("preHandler", async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
    // Admin responses contain credentials (LiveKit key, masked API key, URLs) and
    // must never land in a shared browser cache or a proxy on the LAN.
    reply.header("Cache-Control", "no-store");
  });

  // Used by the admin login form to verify the password.
  app.get("/login", async () => ({ ok: true }));

  // ---- AI settings ---------------------------------------------------------

  app.get("/ai-config", async () => {
    const cfg = await loadAiConfig();
    return {
      openRouterApiKey: maskKey(cfg.openRouterApiKey),
      hasKey: Boolean(cfg.openRouterApiKey),
      model: cfg.model,
      temperature: cfg.temperature,
      sttEngine: cfg.sttEngine,
      ttsProvider: cfg.ttsProvider,
    };
  });

  app.put<{
    Body: {
      openRouterApiKey?: string;
      model?: string;
      temperature?: number;
      sttEngine?: string;
      ttsProvider?: string;
    };
  }>("/ai-config", async (req) => {
    const patch: Parameters<typeof updateAiConfig>[0] = {};
    const key = req.body?.openRouterApiKey;
    // Only overwrite the key when a real (non-masked) value is sent.
    if (typeof key === "string" && key && !key.startsWith("…")) {
      patch.openRouterApiKey = key.trim();
    }
    if (typeof req.body?.model === "string") patch.model = req.body.model.trim();
    if (typeof req.body?.temperature === "number") patch.temperature = req.body.temperature;
    if (typeof req.body?.sttEngine === "string") patch.sttEngine = req.body.sttEngine;
    if (typeof req.body?.ttsProvider === "string") patch.ttsProvider = req.body.ttsProvider;
    const cfg = await updateAiConfig(patch);
    return {
      openRouterApiKey: maskKey(cfg.openRouterApiKey),
      hasKey: Boolean(cfg.openRouterApiKey),
      model: cfg.model,
      temperature: cfg.temperature,
      sttEngine: cfg.sttEngine,
      ttsProvider: cfg.ttsProvider,
    };
  });

  // Proxy OpenRouter's model catalogue so the admin UI can offer a dropdown
  // without exposing the API key to the browser.
  app.get("/ai/models", async (_req, reply) => {
    const cfg = await loadAiConfig();
    const headers: Record<string, string> = {};
    if (cfg.openRouterApiKey) headers.Authorization = `Bearer ${cfg.openRouterApiKey}`;
    try {
      const res = await fetch("https://openrouter.ai/api/v1/models", { headers });
      if (!res.ok) {
        return reply.code(502).send({ error: `OpenRouter error ${res.status}` });
      }
      const data = (await res.json()) as { data?: { id: string; name?: string }[] };
      const models = (data.data ?? [])
        .map((m) => ({ id: m.id, name: m.name ?? m.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { models };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : "could not reach OpenRouter",
      });
    }
  });

  // ---- Languages -----------------------------------------------------------

  app.get("/languages", async () => ({ languages: await listLanguages() }));

  app.post<{
    Body: { code?: string; name?: string; flag?: string };
  }>("/languages", async (req, reply) => {
    const code = (req.body?.code ?? "").toString();
    const name = (req.body?.name ?? "").toString();
    const flag = req.body?.flag?.toString();
    try {
      const entry = await addLanguage(code, name, flag);
      return entry;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "could not add language";
      return reply.code(400).send({ error: msg });
    }
  });

  app.put<{
    Params: { code: string };
    Body: { name?: string; flag?: string };
  }>("/languages/:code", async (req, reply) => {
    const updated = await updateLanguage(req.params.code, {
      name: typeof req.body?.name === "string" ? req.body.name : undefined,
      flag: typeof req.body?.flag === "string" ? req.body.flag : undefined,
    });
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });

  app.delete<{ Params: { code: string } }>(
    "/languages/:code",
    async (req, reply) => {
      const code = normalizeCode(req.params.code);
      // Strip the language from each event (manual + AI), revoke codes for that
      // language, then drop it from the master list.
      await stripLanguageFromEvents(code);
      const allCodes = await listCodes();
      for (const c of allCodes) {
        if (c.language === code) await revokeCode(c.code);
      }
      const ok = await removeLanguage(code);
      if (!ok) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

  // ---- Events --------------------------------------------------------------

  app.get("/events", async () => {
    // Make sure there's always at least one event for the admin UI to land on.
    await ensureDefaultEvent();
    return { events: await listEvents() };
  });

  // Per-channel statistics for one event: a row per language (manual + AI).
  app.get<{ Params: { id: string } }>("/events/:id/stats", async (req, reply) => {
    const event = await getEvent(req.params.id);
    if (!event) return reply.code(404).send({ error: "not found" });
    const languages = [
      ...event.languages.map((code) => ({ code, ai: false })),
      ...(event.aiLanguages ?? []).map((code) => ({ code, ai: true })),
    ];
    // Aggregate the per-bucket concurrent-listener history across every channel
    // into one series for the event-level chart.
    const buckets = new Map<number, number>();
    const channels = languages.map(({ code, ai }) => {
      const { history, ...rest } = statsForRoom(config.roomFor(event.id, code));
      for (const p of history) buckets.set(p.t, (buckets.get(p.t) ?? 0) + p.n);
      return { language: code, ai, ...rest };
    });
    const history = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([t, n]) => ({ t, n }));
    return { channels, history, usage: await usageForEvent(event.id) };
  });

  app.post<{
    Body: {
      name?: string;
      languages?: string[];
      aiLanguages?: string[];
      aiSourceLang?: string;
      glossary?: string;
    };
  }>("/events", async (req, reply) => {
    const name = req.body?.name?.trim();
    const languages = Array.isArray(req.body?.languages) ? req.body!.languages : [];
    const aiLanguages = Array.isArray(req.body?.aiLanguages) ? req.body!.aiLanguages : [];
    const aiSourceLang = req.body?.aiSourceLang?.trim().toLowerCase();
    if (!name) return reply.code(400).send({ error: "name required" });
    // Reject instead of truncating: the admin would otherwise create "Sunday
    // Service – Main Hall Edition 2026" and silently get a cut-off title.
    if (name.length > EVENT_NAME_MAX) {
      return reply.code(400).send({
        error: `name too long (max ${EVENT_NAME_MAX} characters)`,
      });
    }
    if (aiSourceLang && !(await validLanguage(aiSourceLang))) {
      return reply.code(400).send({ error: `unknown aiSourceLang: ${aiSourceLang}` });
    }
    const overlap = languages.filter((l) => aiLanguages.includes(l));
    if (overlap.length > 0) {
      return reply.code(400).send({
        error: `a language can't be both manual and AI: ${overlap.join(", ")}`,
      });
    }
    // AI translation needs to know what is being spoken; the operator has no
    // language picker, so an event without a source language can never go live.
    if (aiLanguages.length > 0 && !aiSourceLang) {
      return reply.code(400).send({ error: "AI languages require an AI source language" });
    }
    const glossary = req.body?.glossary;
    if (typeof glossary === "string" && glossary.length > EVENT_GLOSSARY_MAX) {
      return reply.code(400).send({
        error: `glossary too long (max ${EVENT_GLOSSARY_MAX} characters)`,
      });
    }
    const event = await createEvent(name, languages, aiLanguages, aiSourceLang);
    if (typeof glossary === "string" && glossary.trim()) {
      const withGlossary = await updateEvent(event.id, { glossary });
      return withGlossary ?? event;
    }
    return event;
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      languages?: string[];
      aiLanguages?: string[];
      aiSourceLang?: string | null;
      glossary?: string | null;
      active?: boolean;
    };
  }>("/events/:id", async (req, reply) => {
    const existing = await getEvent(req.params.id);
    if (!existing) return reply.code(404).send({ error: "not found" });

    const patch: {
      name?: string;
      languages?: string[];
      aiLanguages?: string[];
      aiSourceLang?: string | null;
      glossary?: string | null;
      active?: boolean;
    } = {};
    if (typeof req.body?.name === "string") {
      const name = req.body.name.trim();
      // A cleared name leaves a blank row in the admin list and an unnamed
      // event in the listener picker; the create path already requires one.
      if (!name) return reply.code(400).send({ error: "name required" });
      if (name.length > EVENT_NAME_MAX) {
        return reply.code(400).send({
          error: `name too long (max ${EVENT_NAME_MAX} characters)`,
        });
      }
      patch.name = name;
    }
    if (Array.isArray(req.body?.languages)) patch.languages = req.body.languages;
    if (Array.isArray(req.body?.aiLanguages)) patch.aiLanguages = req.body.aiLanguages;
    if (typeof req.body?.aiSourceLang === "string" || req.body?.aiSourceLang === null) {
      patch.aiSourceLang = req.body.aiSourceLang?.trim().toLowerCase() ?? null;
      if (patch.aiSourceLang && !(await validLanguage(patch.aiSourceLang))) {
        return reply.code(400).send({ error: `unknown aiSourceLang: ${patch.aiSourceLang}` });
      }
    }
    if (typeof req.body?.glossary === "string" || req.body?.glossary === null) {
      const glossary = req.body.glossary ?? "";
      if (glossary.length > EVENT_GLOSSARY_MAX) {
        return reply.code(400).send({
          error: `glossary too long (max ${EVENT_GLOSSARY_MAX} characters)`,
        });
      }
      patch.glossary = glossary;
    }
    if (typeof req.body?.active === "boolean") patch.active = req.body.active;

    // Reject any overlap between the effective manual and AI language sets.
    const effLangs = patch.languages ?? existing.languages;
    const effAi = patch.aiLanguages ?? existing.aiLanguages ?? [];
    const overlap = effLangs.filter((l) => effAi.includes(l));
    if (overlap.length > 0) {
      return reply.code(400).send({
        error: `a language can't be both manual and AI: ${overlap.join(", ")}`,
      });
    }
    // Clearing the source language while AI languages remain would strand the
    // AI operator (no STT language) on the next login.
    const effSource =
      patch.aiSourceLang !== undefined ? patch.aiSourceLang : existing.aiSourceLang;
    if (effAi.length > 0 && !effSource) {
      return reply.code(400).send({ error: "AI languages require an AI source language" });
    }

    const updated = await updateEvent(req.params.id, patch);
    if (!updated) return reply.code(404).send({ error: "not found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>("/events/:id", async (req, reply) => {
    const id = req.params.id;
    const ok = await deleteEvent(id);
    if (!ok) return reply.code(404).send({ error: "not found" });
    await clearEventBackground(id);
    await revokeCodesForEvent(id);
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>(
    "/events/:id/background",
    async (req, reply) => {
      const event = await getEvent(req.params.id);
      if (!event) return reply.code(404).send({ error: "event not found" });
      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no file" });
      const upload = await readBackgroundUpload(data);
      if ("error" in upload) return reply.code(upload.status).send({ error: upload.error });
      const ext = BACKGROUND_OUTPUT_EXT;
      await fs.mkdir(config.dataDir, { recursive: true });
      await clearEventBackground(event.id);
      await fs.writeFile(
        path.join(config.dataDir, `event-${event.id}.${ext}`),
        upload.buffer,
      );
      await updateEvent(event.id, { backgroundExt: ext });
      return { ok: true, ext };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/events/:id/background",
    async (req, reply) => {
      const event = await getEvent(req.params.id);
      if (!event) return reply.code(404).send({ error: "event not found" });
      await clearEventBackground(event.id);
      await updateEvent(event.id, { backgroundExt: null });
      return reply.code(204).send();
    },
  );

  // ---- Codes ---------------------------------------------------------------

  app.get<{ Querystring: { eventId?: string } }>("/codes", async (req) => ({
    codes: await listCodes(req.query?.eventId),
  }));

  app.post<{
    Body: { eventId?: string; language?: string; name?: string; role?: string };
  }>("/codes", async (req, reply) => {
    const eventId = req.body?.eventId?.trim();
    const name = req.body?.name?.trim();
    const role = req.body?.role === "ai-operator" ? "ai-operator" : "translator";
    if (!eventId) return reply.code(400).send({ error: "eventId required" });
    if (!name) return reply.code(400).send({ error: "name required" });
    const event = await getEvent(eventId);
    if (!event) return reply.code(404).send({ error: "event not found" });

    if (role === "ai-operator") {
      if (!event.aiLanguages || event.aiLanguages.length === 0) {
        return reply.code(400).send({
          error: "add at least one AI language to this event first",
        });
      }
      return await createCode(eventId, "", name, "ai-operator");
    }

    const language = req.body?.language?.toLowerCase();
    if (!language) return reply.code(400).send({ error: "language required" });
    if (!(await validLanguage(language))) {
      return reply.code(400).send({ error: "unknown language" });
    }
    if (!event.languages.includes(language)) {
      return reply.code(400).send({ error: "language not in event" });
    }
    return await createCode(eventId, language, name, "translator");
  });

  app.delete<{ Params: { code: string } }>(
    "/codes/:code",
    async (req, reply) => {
      const ok = await revokeCode(req.params.code);
      if (!ok) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

  // ---- Default background --------------------------------------------------

  app.post("/background", async (req, reply) => {
    const data = await req.file();
    if (!data) return reply.code(400).send({ error: "no file" });
    const upload = await readBackgroundUpload(data);
    if ("error" in upload) return reply.code(upload.status).send({ error: upload.error });
    const ext = BACKGROUND_OUTPUT_EXT;
    await fs.mkdir(config.dataDir, { recursive: true });
    await clearGlobalBackground();
    await fs.writeFile(path.join(config.dataDir, `background.${ext}`), upload.buffer);
    return { ok: true, ext };
  });

  app.delete("/background", async (_req, reply) => {
    await clearGlobalBackground();
    return reply.code(204).send();
  });

  // Web-admin settings, certificates, credentials and reset. Registered inside
  // this plugin so it inherits the admin auth + rate-limit hooks.
  await app.register(settingsApiPlugin);
};
