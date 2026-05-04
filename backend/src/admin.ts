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
      // Strip the language from each event, revoke codes for that language,
      // then drop it from the master list.
      const events = await listEvents();
      for (const ev of events) {
        if (ev.languages.includes(code)) {
          await updateEvent(ev.id, {
            languages: ev.languages.filter((c) => c !== code),
          });
        }
      }
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

  app.post<{ Body: { name?: string; languages?: string[] } }>(
    "/events",
    async (req, reply) => {
      const name = req.body?.name?.trim();
      const languages = Array.isArray(req.body?.languages) ? req.body!.languages : [];
      if (!name) return reply.code(400).send({ error: "name required" });
      const event = await createEvent(name, languages);
      return event;
    },
  );

  app.put<{
    Params: { id: string };
    Body: { name?: string; languages?: string[] };
  }>("/events/:id", async (req, reply) => {
    const patch: { name?: string; languages?: string[] } = {};
    if (typeof req.body?.name === "string") patch.name = req.body.name.trim();
    if (Array.isArray(req.body?.languages)) patch.languages = req.body.languages;
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
    Body: { eventId?: string; language?: string; name?: string };
  }>("/codes", async (req, reply) => {
    const eventId = req.body?.eventId?.trim();
    const language = req.body?.language?.toLowerCase();
    const name = req.body?.name?.trim();
    if (!eventId) return reply.code(400).send({ error: "eventId required" });
    if (!language) return reply.code(400).send({ error: "language required" });
    if (!(await validLanguage(language))) {
      return reply.code(400).send({ error: "unknown language" });
    }
    if (!name) return reply.code(400).send({ error: "name required" });
    const event = await getEvent(eventId);
    if (!event) return reply.code(404).send({ error: "event not found" });
    if (!event.languages.includes(language)) {
      return reply.code(400).send({ error: "language not in event" });
    }
    return await createCode(eventId, language, name);
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
