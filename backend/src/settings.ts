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

import { existsSync, readFileSync, renameSync } from "node:fs";
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

/**
 * A hostname/IP that can be used as a Caddy site address. Deliberately strict:
 * the value ends up in the Caddyfile, so anything with whitespace, braces or
 * newlines would let a caller inject arbitrary Caddy directives.
 */
const HOSTNAME_RE =
  /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isValidHost(value: string): boolean {
  // A digits-and-dots value is meant as an IPv4 literal; accepting it as a
  // "hostname" would make Caddy attempt ACME for a name that cannot resolve.
  if (/^[0-9.]+$/.test(value)) return IPV4_RE.test(value);
  return HOSTNAME_RE.test(value) && value.includes(".");
}

/** Throws a descriptive error for a value that must not reach the Caddyfile. */
export function assertValidHost(value: string, field: string): void {
  if (!isValidHost(value)) throw new Error(`invalid ${field}: ${JSON.stringify(value)}`);
}

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
    // Drop any host that could inject Caddy directives (e.g. a hand-edited or
    // restored settings.json): an invalid host must not reach the Caddyfile.
    customDomain:
      typeof p.customDomain === "string" && p.customDomain.trim()
        ? isValidHost(p.customDomain.trim())
          ? p.customDomain.trim()
          : (console.error("[settings] ignoring invalid customDomain:", p.customDomain), null)
        : null,
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
      // Keep the broken file for inspection, then rebuild from the env vars so
      // a desktop install (no ADMIN_PASSWORD in the environment) is not locked
      // out of its own admin UI forever.
      const backup = `${settingsFile}.corrupt-${Date.now()}`;
      console.error(`[settings] unreadable settings.json, moved to ${backup}:`, err);
      try {
        renameSync(settingsFile, backup);
      } catch {
        /* best effort */
      }
    }
  }
  cache = normalize({});
  return cache;
}

export function saveSettings(next: Settings): Settings {
  const previous = cache;
  const normalized = normalize(next);
  try {
    writeAtomicSync(settingsFile, JSON.stringify(normalized, null, 2), 0o600);
  } catch (err) {
    // Do not pretend the change was persisted: report the failure and keep the
    // previous state, otherwise the admin UI reports success for lost settings.
    cache = previous;
    throw err;
  }
  cache = normalized;
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return saveSettings({ ...getSettings(), ...patch });
}

/** Persist the file on first boot if it doesn't exist yet. Idempotent. */
export function ensureSettingsFile(): Settings {
  const current = getSettings();
  if (!existsSync(settingsFile)) {
    try {
      saveSettings(current);
    } catch (err) {
      // Boot must not die here: a read-only data dir is reported on every write
      // attempt with a proper 500 instead of an endless restart loop.
      console.error("[settings] could not seed settings.json:", err);
    }
  }
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
