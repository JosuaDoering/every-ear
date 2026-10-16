// First-run handling: generate random secrets, create userData dirs, persist
// the initial settings.json (shared with the backend). Idempotent — once the
// file exists with credentials, subsequent launches are a no-op.

import { existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { loadSettings, saveSettings, type Settings } from "./config-store";
import { dataDir, logDir, settingsPath, userDataDir } from "./paths";

export type BootstrapResult = {
  config: Settings;
  /** True only on the first launch ever (or after all data was removed). */
  isFirstRun: boolean;
};

export function bootstrap(): BootstrapResult {
  mkdirSync(userDataDir(), { recursive: true });
  mkdirSync(dataDir(), { recursive: true });
  mkdirSync(logDir(), { recursive: true });

  const existed = existsSync(settingsPath());
  const current = loadSettings();
  if (existed && current.livekitApiKey && current.adminPassword) {
    return { config: current, isFirstRun: false };
  }

  const next = saveSettings({
    ...current,
    livekitApiKey: current.livekitApiKey || `lk_${randomBytes(8).toString("hex")}`,
    livekitApiSecret: current.livekitApiSecret || randomBytes(32).toString("base64url"),
    adminPassword: current.adminPassword || randomBytes(12).toString("base64url"),
  });
  return { config: next, isFirstRun: !existed };
}
