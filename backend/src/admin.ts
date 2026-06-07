import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import {
  createCode,
  listCodes,
  revokeCode,
  revokeCodesForEvent,
} from "./codes.js";
import {
  ALLOWED_BG_EXT,
  clearEventBackground,
  clearGlobalBackground,
} from "./background.js";
import {
  createEvent,
  deleteEvent,
  ensureDefaultEvent,
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
import { statsForRoom } from "./stats.js";

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(header: string | undefined): boolean {
  if (!header || !header.startsWith("Bearer ")) return false;
  return constantTimeEqual(header.slice(7).trim(), config.adminPassword);
}

export const adminPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.addHook("preHandler", async (req, reply) => {
    if (!authorized(req.headers.authorization)) {
      return reply.code(401).send({ error: "unauthorized" });
    }
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
    return { channels, history };
  });

  app.post<{
    Body: { name?: string; languages?: string[]; aiLanguages?: string[]; aiSourceLang?: string };
  }>("/events", async (req, reply) => {
    const name = req.body?.name?.trim();
    const languages = Array.isArray(req.body?.languages) ? req.body!.languages : [];
    const aiLanguages = Array.isArray(req.body?.aiLanguages) ? req.body!.aiLanguages : [];
    const aiSourceLang = req.body?.aiSourceLang?.toLowerCase();
    if (!name) return reply.code(400).send({ error: "name required" });
    const overlap = languages.filter((l) => aiLanguages.includes(l));
    if (overlap.length > 0) {
      return reply.code(400).send({
        error: `a language can't be both manual and AI: ${overlap.join(", ")}`,
      });
    }
    const event = await createEvent(name, languages, aiLanguages, aiSourceLang);
    return event;
  });

  app.put<{
    Params: { id: string };
    Body: {
      name?: string;
      languages?: string[];
      aiLanguages?: string[];
      aiSourceLang?: string | null;
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
      active?: boolean;
    } = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
    if (Array.isArray(req.body?.languages)) patch.languages = req.body.languages;
    if (Array.isArray(req.body?.aiLanguages)) patch.aiLanguages = req.body.aiLanguages;
    if (typeof req.body?.aiSourceLang === "string" || req.body?.aiSourceLang === null) {
      patch.aiSourceLang = req.body.aiSourceLang;
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
      if (!data.mimetype.startsWith("image/")) {
        return reply.code(400).send({ error: "must be an image" });
      }
      const ext = data.mimetype.split("/")[1]?.toLowerCase() ?? "";
      if (!ALLOWED_BG_EXT.has(ext)) {
        return reply.code(400).send({ error: `unsupported type: ${data.mimetype}` });
      }
      const buffer = await data.toBuffer();
      await fs.mkdir(config.dataDir, { recursive: true });
      await clearEventBackground(event.id);
      await fs.writeFile(
        path.join(config.dataDir, `event-${event.id}.${ext}`),
        buffer,
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
    if (!data.mimetype.startsWith("image/")) {
      return reply.code(400).send({ error: "must be an image" });
    }
    const ext = data.mimetype.split("/")[1]?.toLowerCase() ?? "";
    if (!ALLOWED_BG_EXT.has(ext)) {
      return reply.code(400).send({ error: `unsupported type: ${data.mimetype}` });
    }
    const buffer = await data.toBuffer();
    await fs.mkdir(config.dataDir, { recursive: true });
    await clearGlobalBackground();
    await fs.writeFile(path.join(config.dataDir, `background.${ext}`), buffer);
    return { ok: true, ext };
  });

  app.delete("/background", async (_req, reply) => {
    await clearGlobalBackground();
    return reply.code(204).send();
  });
};
