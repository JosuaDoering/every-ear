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
// A tiny file can decode to an enormous bitmap ("decompression bomb"): a 3 MB
// PNG of 16000×16000 already needs ~90 MB of RSS and a second of CPU, and only
// the admin can upload here, but a stolen session must not be able to stall the
// box. 50 MP comfortably covers any real photo while bounding the work.
const BG_MAX_INPUT_PIXELS = 50_000_000;

/** The extension every uploaded background is stored under after compression. */
export const BACKGROUND_OUTPUT_EXT = "webp";

/**
 * Resize-to-fit (never upscaling) and re-encode an uploaded image to WebP.
 * Rejects (throws) if the input isn't a decodable image.
 */
export async function compressBackgroundImage(input: Buffer): Promise<Buffer> {
  return sharp(input, { failOn: "none", limitInputPixels: BG_MAX_INPUT_PIXELS })
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

export type UploadPart = {
  mimetype: string;
  toBuffer: () => Promise<Buffer>;
  file?: { truncated?: boolean };
};

/**
 * Validate, read and compress an uploaded background. Failures carry the HTTP
 * status they deserve: an oversized photo is a 413, not the generic "could not
 * process image" that sends the admin hunting for a broken file.
 */
export async function readBackgroundUpload(
  part: UploadPart,
): Promise<{ buffer: Buffer } | { status: number; error: string }> {
  if (!part.mimetype.startsWith("image/")) {
    return { status: 400, error: "must be an image" };
  }
  const inputExt = part.mimetype.split("/")[1]?.toLowerCase() ?? "";
  if (!ALLOWED_BG_EXT.has(inputExt)) {
    return { status: 400, error: `unsupported type: ${part.mimetype}` };
  }

  let raw: Buffer;
  try {
    raw = await part.toBuffer();
  } catch (err) {
    if ((err as { code?: string }).code === "FST_REQ_FILE_TOO_LARGE" || part.file?.truncated) {
      return { status: 413, error: "image too large (max 10 MB)" };
    }
    return { status: 400, error: "could not read upload" };
  }

  try {
    return { buffer: await compressBackgroundImage(raw) };
  } catch (err) {
    if (/pixel limit/i.test(err instanceof Error ? err.message : "")) {
      return { status: 413, error: "image has too many pixels (max 50 megapixels)" };
    }
    return { status: 400, error: "could not process image" };
  }
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
  // Serve a background file with a weak ETag so repeat loads / the 600-device
  // join burst turn into cheap 304s instead of re-sending the whole image.
  async function sendBackground(
    req: { headers: Record<string, string | string[] | undefined> },
    reply: import("fastify").FastifyReply,
    bg: { path: string; mime: string },
  ) {
    const st = await fs.stat(bg.path);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    reply.header("ETag", etag);
    reply.header("Cache-Control", "public, max-age=300, must-revalidate");
    if (req.headers["if-none-match"] === etag) {
      return reply.code(304).send();
    }
    reply.header("Content-Type", bg.mime);
    return reply.send(createReadStream(bg.path));
  }

  app.get("/api/background", async (req, reply) => {
    const bg = await findGlobalBackground();
    if (!bg) return reply.code(404).send({ error: "no background" });
    return sendBackground(req, reply, bg);
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
      return sendBackground(req, reply, bg);
    },
  );
}
