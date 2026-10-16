// Shared settings store at <userData>/data/settings.json (mode 0o600).
//
// The backend reads and writes the exact same file (see backend/src/settings.ts)
// — this is a thin mirror so the launcher can read the LiveKit credentials,
// listener port and public host it needs before starting the stack. Plain JSON:
// secrets are re-exported as process.env on the child processes anyway, so
// encrypting at rest would be performative.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dataDir, settingsPath } from "./paths";

export type Settings = {
  adminPassword: string;
  listenerPort: number;
  livekitApiKey: string;
  livekitApiSecret: string;
  languages: string;
  preferredInterface: string | null;
  publicHost: string | null;
  customDomain: string | null;
  customCertFile: string | null;
  customKeyFile: string | null;
  netcupCustomerId: string | null;
  netcupApiKey: string | null;
  netcupApiPassword: string | null;
  createdAt: string;
};

const DEFAULTS_LANGUAGES = "en,de,fr,es";

let cache: Settings | null = null;

function normalize(p: Partial<Settings>): Settings {
  return {
    adminPassword: p.adminPassword ?? "",
    listenerPort: Number(p.listenerPort ?? 8443) || 8443,
    livekitApiKey: p.livekitApiKey ?? "",
    livekitApiSecret: p.livekitApiSecret ?? "",
    languages: p.languages ?? DEFAULTS_LANGUAGES,
    preferredInterface: p.preferredInterface ?? null,
    publicHost: p.publicHost ?? null,
    customDomain: p.customDomain ?? null,
    customCertFile: p.customCertFile ?? null,
    customKeyFile: p.customKeyFile ?? null,
    netcupCustomerId: p.netcupCustomerId ?? null,
    netcupApiKey: p.netcupApiKey ?? null,
    netcupApiPassword: p.netcupApiPassword ?? null,
    createdAt: p.createdAt ?? new Date().toISOString(),
  };
}

/**
 * Read settings fresh from disk every time: the backend (web admin) also writes
 * this file, so a cached copy would go stale after e.g. a credential rotation.
 */
export function loadSettings(): Settings {
  if (existsSync(settingsPath())) {
    try {
      return normalize(JSON.parse(readFileSync(settingsPath(), "utf8")) as Partial<Settings>);
    } catch (err) {
      console.error("[settings] failed to read settings.json:", err);
    }
  }
  return normalize({});
}

export function saveSettings(next: Settings): Settings {
  cache = normalize(next);
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(cache, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  return cache;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  return saveSettings({ ...loadSettings(), ...patch });
}
