import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { listenerToken, translatorToken } from "./tokens.js";
import { getCode, listCodes, markUsed } from "./codes.js";
import { getEvent, listActiveEvents, listEvents } from "./events.js";
import {
  getLanguage,
  listLanguages,
  validLanguage,
} from "./languages.js";
import { adminPlugin } from "./admin.js";
import { registerBackgroundRoutes } from "./background.js";

async function start() {
  const app = Fastify({ logger: true });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
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
        .map((e) => ({
          id: e.id,
          name: e.name,
          languages: e.languages
            .map((c) => byCode.get(c))
            .filter((l): l is (typeof langs)[number] => Boolean(l)),
          hasBackground: Boolean(e.backgroundExt),
        })),
    };
  });

  app.post<{ Body: { eventId?: string; language?: string } }>(
    "/api/token/listener",
    async (req, reply) => {
      const eventId = req.body?.eventId?.trim();
      const language = req.body?.language?.toLowerCase();
      if (!eventId) return reply.code(400).send({ error: "eventId required" });
      if (!language || !(await validLanguage(language))) {
        return reply.code(400).send({ error: "unknown language" });
      }
      const event = await getEvent(eventId);
      if (!event) return reply.code(404).send({ error: "event not found" });
      if (!event.languages.includes(language)) {
        return reply.code(400).send({ error: "language not in event" });
      }
      const token = await listenerToken(eventId, language);
      return { token, room: config.roomFor(eventId, language) };
    },
  );

  app.post<{ Body: { code?: string } }>(
    "/api/token/translator",
    async (req, reply) => {
      const code = req.body?.code?.trim();
      if (!code || !/^\d{6}$/.test(code)) {
        return reply.code(400).send({ error: "code must be 6 digits" });
      }
      const entry = await getCode(code);
      if (!entry) return reply.code(404).send({ error: "code not found" });
      const event = await getEvent(entry.eventId);
      if (!event) return reply.code(410).send({ error: "event no longer exists" });
      const lang = await getLanguage(entry.language);
      if (!lang) {
        return reply.code(410).send({ error: "language no longer configured" });
      }
      const token = await translatorToken(entry.eventId, entry.language, entry.name);
      await markUsed(code);
      return {
        token,
        room: config.roomFor(entry.eventId, entry.language),
        language: entry.language,
        languageName: lang.name,
        flag: lang.flag,
        name: entry.name,
        eventId: event.id,
        eventName: event.name,
        eventHasBackground: Boolean(event.backgroundExt),
      };
    },
  );

  registerBackgroundRoutes(app);
  await app.register(adminPlugin, { prefix: "/api/admin" });

  // Trigger the codes-file migration on boot so listeners can see the
  // auto-created default event without first hitting an admin route.
  await listCodes();

  await app.listen({ port: config.port, host: "127.0.0.1" });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
