// First-run handling: generate random secrets, create userData dirs, persist
// the initial config.json. Idempotent — calling on subsequent launches is a
// no-op once config.json exists.

import { mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { defaultsFor, load, save, type StoredConfig } from "./config-store";
import { dataDir, logDir, userDataDir } from "./paths";

export type BootstrapResult = {
  config: StoredConfig;
  /** True only on the first launch ever (or after Reset all data). */
  isFirstRun: boolean;
};

export function bootstrap(): BootstrapResult {
  // The userData dir is created by Electron itself, but the data + log
  // children are ours — make sure they exist before any child process boots.
  mkdirSync(userDataDir(), { recursive: true });
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });

  const existing = load();
  if (existing) {
    return { config: existing, isFirstRun: false };
  }

  const fresh = defaultsFor({
    livekitApiKey: `lk_${randomBytes(8).toString("hex")}`,
    livekitApiSecret: randomBytes(32).toString("base64url"),
    adminPassword: randomBytes(12).toString("base64url"),
  });
  save(fresh);
  return { config: fresh, isFirstRun: true };
}

export function regenerateLiveKitCredentials(): StoredConfig {
  const current = load();
  if (!current) throw new Error("regenerate: no config to update");
  return save({
    ...current,
    livekitApiKey: `lk_${randomBytes(8).toString("hex")}`,
    livekitApiSecret: randomBytes(32).toString("base64url"),
  });
}
