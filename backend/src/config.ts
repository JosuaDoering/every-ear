import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir, getSettings } from "./settings.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

// LiveKit learns new credentials only when it restarts (it reads them from its
// env file at start). Signing tokens with a freshly rotated pair would therefore
// reject every join until the restart, so we snapshot the pair once per process
// and switch over together with LiveKit.
let bootCredentials: { key: string; secret: string } | null = null;

function livekitCredentials(): { key: string; secret: string } {
  if (bootCredentials) return bootCredentials;
  const s = getSettings();
  // An incomplete pair (first install) is not cached, so a later configuration
  // is picked up immediately.
  if (!s.livekitApiKey || !s.livekitApiSecret) {
    return { key: s.livekitApiKey, secret: s.livekitApiSecret };
  }
  bootCredentials = { key: s.livekitApiKey, secret: s.livekitApiSecret };
  return bootCredentials;
}

// Values that can change at runtime (web admin) are exposed as getters so a
// change is picked up without a restart. Static values (ports, paths) are
// plain properties.
export const config = {
  get apiKey(): string {
    return livekitCredentials().key;
  },
  get apiSecret(): string {
    return livekitCredentials().secret;
  },
  get adminPassword(): string {
    return getSettings().adminPassword;
  },
  get listenerPort(): number {
    return getSettings().listenerPort;
  },
  port: Number(process.env.BACKEND_PORT ?? 3000),
  // The desktop app and the installer override these via env so runtime data
  // lives in a writable location (the bundle itself is read-only).
  dataDir,
  frontendDist:
    process.env.FRONTEND_DIST ?? path.join(projectRoot, "frontend", "dist"),
  logDir: process.env.EVERY_EAR_LOG_DIR ?? path.join(projectRoot, "logs"),
  defaultBackgroundPath:
    process.env.EVERY_EAR_DEFAULT_BG ??
    path.join(projectRoot, "frontend", "public", "bg.jpg"),
  roomFor: (eventId: string, languageCode: string) =>
    `event-${eventId}-lang-${languageCode}`,
};
