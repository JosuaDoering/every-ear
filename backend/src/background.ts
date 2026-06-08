import type { FastifyInstance } from "fastify";
import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { config } from "./config.js";
import { getEvent } from "./events.js";

const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  avif: "image/avif",
  gif: "image/gif",
};

export const ALLOWED_BG_EXT = new Set(Object.keys(EXT_MIME));

export function mimeForExt(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] ?? "application/octet-stream";
}

// Backgrounds are re-encoded to WebP on upload: WebP keeps near-original
// quality at a fraction of the size of source JPEG/PNG photos, and every
// modern browser decodes it. We also cap the dimensions so a 6000px phone
// photo doesn't ship to every listener at full resolution — the image is only
// ever shown as a full-bleed page backdrop.
const BG_MAX_DIMENSION = 2048;
const BG_WEBP_QUALITY = 80;

/** The extension every uploaded background is stored under after compression. */
export const BACKGROUND_OUTPUT_EXT = "webp";

/**
 * Resize-to-fit (never upscaling) and re-encode an uploaded image to WebP.
 * Rejects (throws) if the input isn't a decodable image.
 */
export async function compressBackgroundImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "none" })
    .rotate() // apply EXIF orientation before the metadata is dropped
    .resize({
      width: BG_MAX_DIMENSION,
      height: BG_MAX_DIMENSION,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({ quality: BG_WEBP_QUALITY })
    .toBuffer();
}

async function findFileWithPrefix(
  prefix: string,
): Promise<{ path: string; mime: string } | null> {
  try {
    const files = await fs.readdir(config.dataDir);
    const match = files.find((f) => f.startsWith(prefix + "."));
    if (match) {
      const ext = match.split(".").pop()!.toLowerCase();
      return {
        path: path.join(config.dataDir, match),
        mime: mimeForExt(ext),
      };
    }
  } catch {
    // Data dir doesn't exist yet — fall through.
  }
  return null;
}

async function findGlobalBackground(): Promise<{ path: string; mime: string } | null> {
  const uploaded = await findFileWithPrefix("background");
  if (uploaded) return uploaded;
  try {
    await fs.access(config.defaultBackgroundPath);
    return { path: config.defaultBackgroundPath, mime: "image/jpeg" };
  } catch {
    return null;
  }
}

export async function findEventBackground(
  eventId: string,
): Promise<{ path: string; mime: string } | null> {
  return findFileWithPrefix(`event-${eventId}`);
}

export async function clearGlobalBackground(): Promise<void> {
  await clearByPrefix("background");
}

export async function clearEventBackground(eventId: string): Promise<void> {
  await clearByPrefix(`event-${eventId}`);
}

async function clearByPrefix(prefix: string): Promise<void> {
  try {
    const files = await fs.readdir(config.dataDir);
    for (const f of files) {
      if (f.startsWith(prefix + ".")) {
        await fs.unlink(path.join(config.dataDir, f)).catch(() => {});
      }
    }
  } catch {
    // ignore
  }
}

export function registerBackgroundRoutes(app: FastifyInstance): void {
  app.get("/api/background", async (_req, reply) => {
    const bg = await findGlobalBackground();
    if (!bg) return reply.code(404).send({ error: "no background" });
    reply.header("Content-Type", bg.mime);
    reply.header("Cache-Control", "no-cache, must-revalidate");
    return createReadStream(bg.path);
  });

  app.get<{ Params: { id: string } }>(
    "/api/events/:id/background",
    async (req, reply) => {
      const event = await getEvent(req.params.id);
      if (!event) return reply.code(404).send({ error: "event not found" });
      const bg =
        (event.backgroundExt && (await findEventBackground(event.id))) ||
        (await findGlobalBackground());
      if (!bg) return reply.code(404).send({ error: "no background" });
      reply.header("Content-Type", bg.mime);
      reply.header("Cache-Control", "no-cache, must-revalidate");
      return createReadStream(bg.path);
    },
  );
}
