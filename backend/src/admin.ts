import type { FastifyInstance, FastifyPluginAsync } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { createCode, listCodes, revokeCode } from "./codes.js";
import { ALLOWED_BG_EXT, clearUploadedBackground } from "./background.js";

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

  app.get("/codes", async () => ({ codes: await listCodes() }));

  app.post<{ Body: { language?: string; name?: string } }>(
    "/codes",
    async (req, reply) => {
      const language = req.body?.language?.toLowerCase();
      const name = req.body?.name?.trim();
      if (!language || !config.validLanguage(language)) {
        return reply.code(400).send({ error: "unknown language" });
      }
      if (!name) {
        return reply.code(400).send({ error: "name required" });
      }
      return await createCode(language, name);
    },
  );

  app.delete<{ Params: { code: string } }>(
    "/codes/:code",
    async (req, reply) => {
      const ok = await revokeCode(req.params.code);
      if (!ok) return reply.code(404).send({ error: "not found" });
      return reply.code(204).send();
    },
  );

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
    await clearUploadedBackground();
    await fs.writeFile(path.join(config.dataDir, `background.${ext}`), buffer);
    return { ok: true, ext };
  });

  app.delete("/background", async (_req, reply) => {
    await clearUploadedBackground();
    return reply.code(204).send();
  });
};
