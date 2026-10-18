// Backend-owned settings store.
//
// This is the single source of truth for everything configurable from the web
// admin: admin password, listener port, LiveKit credentials, custom TLS
// domain/certificate, and the optional Netcup DNS credentials used for
// automated ACME. It is shared by the desktop app and the headless server
// (both point EVERY_EAR_DATA_DIR at the same place).
//
// First boot seeds the file from environment variables, so the installer / the
// desktop bootstrap only have to set env once.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeAtomicSync } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..", "..");

/** Runtime data directory (shared by backend, desktop and the installer). */
export const dataDir =
  process.env.EVERY_EAR_DATA_DIR ?? path.join(projectRoot, "backend", "data");

export const settingsFile = path.join(dataDir, "settings.json");

export type Settings = {
  adminPassword: string;
  /** TCP port Caddy binds for the listener-facing HTTPS server. */
  listenerPort: number;
  livekitApiKey: string;
  livekitApiSecret: string;
  /** Initial language seed (only used the first time languages.json is created). */
  languages: string;
  /** Persisted LAN interface choice when several are available. */
  preferredInterface: string | null;
  /** Public hostname/IP listeners use. Detected by the launcher, editable via web. */
  publicHost: string | null;
  /** Optional custom domain used as the Caddy hostname (e.g. events.example.com). */
  customDomain: string | null;
  /** PEM TLS certificate file. Paired with customKeyFile. */
  customCertFile: string | null;
  /** PEM TLS private key file. Paired with customCertFile. */
  customKeyFile: string | null;
  /** netcup REST API key (64 chars) for automated ACME DNS-01. */
  netcupApiKey: string | null;
  createdAt: string;
};

const DEFAULTS_LANGUAGES = process.env.LANGUAGES ?? "en,de,fr,es";

let cache: Settings | null = null;

function normalize(p: Partial<Settings>): Settings {
  return {
    adminPassword: p.adminPassword ?? process.env.ADMIN_PASSWORD ?? "",
    listenerPort: Number(p.listenerPort ?? process.env.LISTENER_PORT ?? 8443) || 8443,
    livekitApiKey: p.livekitApiKey ?? process.env.LIVEKIT_API_KEY ?? "",
    livekitApiSecret: p.livekitApiSecret ?? process.env.LIVEKIT_API_SECRET ?? "",
    languages: p.languages ?? DEFAULTS_LANGUAGES,
    preferredInterface: p.preferredInterface ?? null,
    publicHost: p.publicHost ?? process.env.PUBLIC_HOST ?? process.env.LIVEKIT_NODE_IP ?? null,
    customDomain: p.customDomain ?? null,
    customCertFile: p.customCertFile ?? null,
    customKeyFile: p.customKeyFile ?? null,
    netcupApiKey: p.netcupApiKey ?? null,
    createdAt: p.createdAt ?? new Date().toISOString(),
  };
}

export function getSettings(): Settings {
  if (cache) return cache;
  if (existsSync(settingsFile)) {
    try {
      cache = normalize(JSON.parse(readFileSync(settingsFile, "utf8")) as Partial<Settings>);
      return cache;
    } catch (err) {
      console.error("[settings] failed to read settings.json:", err);
    }
  }
  cache = normalize({});
  return cache;
}

export function saveSettings(next: Settings): Settings {
  cache = normalize(next);
  try {
    // Atomic + creates dataDir: never leave a half-written settings file.
    writeAtomicSync(settingsFile, JSON.stringify(cache, null, 2), 0o600);
  } catch (err) {
    console.error("[settings] failed to write settings.json:", err);
  }
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return saveSettings({ ...getSettings(), ...patch });
}

/** Persist the file on first boot if it doesn't exist yet. Idempotent. */
export function ensureSettingsFile(): Settings {
  const current = getSettings();
  if (!existsSync(settingsFile)) saveSettings(current);
  return current;
}

/**
 * Write a systemd-readable env file with the LiveKit credentials, so the
 * headless livekit.service picks up credentials regenerated from the web admin.
 * (The desktop launcher passes them on the CLI instead.)
 */
export function writeLivekitEnv(): void {
  const s = getSettings();
  const port = process.env.BACKEND_PORT ?? "3000";
  const content =
    [
      `LIVEKIT_API_KEY=${s.livekitApiKey}`,
      `LIVEKIT_API_SECRET=${s.livekitApiSecret}`,
      `LIVEKIT_WEBHOOK_API_KEY=${s.livekitApiKey}`,
      `LIVEKIT_WEBHOOK_URLS=http://127.0.0.1:${port}/api/livekit/webhook`,
      "",
    ].join("\n");
  try {
    writeAtomicSync(path.join(dataDir, "livekit.env"), content, 0o600);
  } catch (err) {
    console.error("[settings] failed to write livekit.env:", err);
  }
}
