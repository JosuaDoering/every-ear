import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { listenerToken, translatorToken } from "./tokens.js";
import { getCode, markUsed } from "./codes.js";
import { adminPlugin } from "./admin.js";
import { registerBackgroundRoute } from "./background.js";

async function start() {
  const app = Fastify({ logger: true });

  await app.register(multipart, {
    limits: { fileSize: 10 * 1024 * 1024 },
  });

  app.get("/api/languages", async () => ({ languages: config.languages }));

  app.post<{ Body: { language?: string } }>(
    "/api/token/listener",
    async (req, reply) => {
      const language = req.body?.language?.toLowerCase();
      if (!language || !config.validLanguage(language)) {
        return reply.code(400).send({ error: "unknown language" });
      }
      const token = await listenerToken(language);
      return { token, room: config.roomFor(language) };
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
      const token = await translatorToken(entry.language, entry.name);
      await markUsed(code);
      const lang = config.languages.find((l) => l.code === entry.language);
      return {
        token,
        room: config.roomFor(entry.language),
        language: entry.language,
        languageName: lang?.name ?? entry.language.toUpperCase(),
        flag: lang?.flag ?? "🏳️",
        name: entry.name,
      };
    },
  );

  registerBackgroundRoute(app);
  await app.register(adminPlugin, { prefix: "/api/admin" });

  await app.listen({ port: config.port, host: "127.0.0.1" });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
