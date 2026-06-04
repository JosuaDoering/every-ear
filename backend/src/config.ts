import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const config = {
  apiKey: required("LIVEKIT_API_KEY"),
  apiSecret: required("LIVEKIT_API_SECRET"),
  adminPassword: required("ADMIN_PASSWORD"),
  port: Number(process.env.BACKEND_PORT ?? 3000),
  // The desktop app overrides these via env so runtime data lives in the
  // user's app-data dir (the bundle itself is read-only).
  dataDir:
    process.env.EVERY_EAR_DATA_DIR ??
    path.join(projectRoot, "backend", "data"),
  defaultBackgroundPath:
    process.env.EVERY_EAR_DEFAULT_BG ??
    path.join(projectRoot, "frontend", "public", "bg.jpg"),
  roomFor: (eventId: string, languageCode: string) =>
    `event-${eventId}-lang-${languageCode}`,
};
