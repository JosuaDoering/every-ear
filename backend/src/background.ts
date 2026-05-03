import type { FastifyInstance } from "fastify";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { config } from "./config.js";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

export const ALLOWED_BG_EXT = new Set(Object.keys(EXT_MIME));

export async function findBackground(): Promise<{ path: string; mime: string } | null> {
  try {
    const files = await fs.readdir(config.dataDir);
    const match = files.find((f) => f.startsWith("background."));
    if (match) {
      const ext = match.split(".").pop()!.toLowerCase();
      return {
        path: path.join(config.dataDir, match),
        mime: EXT_MIME[ext] ?? "application/octet-stream",
      };
    }
  } catch {
    // Data dir doesn't exist yet — fall through to default.
  }
  try {
    await fs.access(config.defaultBackgroundPath);
    return { path: config.defaultBackgroundPath, mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export async function clearUploadedBackground(): Promise<void> {
  try {
    const files = await fs.readdir(config.dataDir);
    for (const f of files) {
      if (f.startsWith("background.")) {
        await fs.unlink(path.join(config.dataDir, f)).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

export function registerBackgroundRoute(app: FastifyInstance): void {
  app.get("/api/background", async (_req, reply) => {
    const bg = await findBackground();
    if (!bg) return reply.code(404).send({ error: "no background" });
    reply.header("Content-Type", bg.mime);
    reply.header("Cache-Control", "no-cache, must-revalidate");
    return createReadStream(bg.path);
  });
}
