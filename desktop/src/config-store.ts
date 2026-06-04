// Persistent settings stored at userData/config.json (mode 0o600).
// Plain JSON: secrets are immediately re-exported as process.env on the
// child processes anyway, so encrypting at rest would be performative.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { configFile } from "./paths";

export type StoredConfig = {
  livekitApiKey: string;
  livekitApiSecret: string;
  adminPassword: string;
  /** Persisted user choice when multiple LAN interfaces are available. */
  preferredInterface: string | null;
  /** Initial seed for the language list (only used on first backend boot). */
  languages: string;
  /** ISO timestamp of when the file was first created — debug aid. */
  createdAt: string;
  /** Optional custom domain to use as the Caddy hostname (e.g. "events.example.com"). */
  customDomain: string | null;
  /** Path to a PEM-encoded TLS certificate file. Requires customKeyFile. */
  customCertFile: string | null;
  /** Path to a PEM-encoded TLS private key file. Requires customCertFile. */
  customKeyFile: string | null;
  /** Netcup CCP API customer number (used for automated ACME DNS-01). */
  netcupCustomerId: string | null;
  /** Netcup CCP API key. */
  netcupApiKey: string | null;
  /** Netcup CCP API password. */
  netcupApiPassword: string | null;
};

const DEFAULTS_LANGUAGES = "en,de,fr,es";

let cache: StoredConfig | null = null;

export function load(): StoredConfig | null {
  if (cache) return cache;
  if (!existsSync(configFile())) return null;
  try {
    const raw = readFileSync(configFile(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StoredConfig>;
    cache = normalize(parsed);
    return cache;
  } catch {
    return null;
  }
}

export function save(next: StoredConfig): StoredConfig {
  cache = normalize(next);
  writeFileSync(configFile(), JSON.stringify(cache, null, 2), {
    mode: 0o600,
    encoding: "utf8",
  });
  return cache;
}

export function update(patch: Partial<StoredConfig>): StoredConfig {
  const current = load();
  if (!current) {
    throw new Error("config-store: no existing config to patch — call save() first");
  }
  return save({ ...current, ...patch });
}

export function defaultsFor(seed: {
  livekitApiKey: string;
  livekitApiSecret: string;
  adminPassword: string;
}): StoredConfig {
  return {
    livekitApiKey: seed.livekitApiKey,
    livekitApiSecret: seed.livekitApiSecret,
    adminPassword: seed.adminPassword,
    preferredInterface: null,
    languages: DEFAULTS_LANGUAGES,
    createdAt: new Date().toISOString(),
    customDomain: null,
    customCertFile: null,
    customKeyFile: null,
    netcupCustomerId: null,
    netcupApiKey: null,
    netcupApiPassword: null,
  };
}

function normalize(p: Partial<StoredConfig>): StoredConfig {
  return {
    livekitApiKey: p.livekitApiKey ?? "",
    livekitApiSecret: p.livekitApiSecret ?? "",
    adminPassword: p.adminPassword ?? "",
    preferredInterface: p.preferredInterface ?? null,
    languages: p.languages ?? DEFAULTS_LANGUAGES,
    createdAt: p.createdAt ?? new Date().toISOString(),
    customDomain: p.customDomain ?? null,
    customCertFile: p.customCertFile ?? null,
    customKeyFile: p.customKeyFile ?? null,
    netcupCustomerId: p.netcupCustomerId ?? null,
    netcupApiKey: p.netcupApiKey ?? null,
    netcupApiPassword: p.netcupApiPassword ?? null,
  };
}
