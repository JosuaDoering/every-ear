#!/usr/bin/env node
// Print the listener / translator URLs and an inline QR code.
// Cross-platform replacement for the old bash show-url.sh.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const envPath = path.join(projectRoot, ".env");

// .env is optional: a Debian/systemd install keeps its values in
// /etc/every-ear/env and a desktop install has no .env at all, but both have a
// settings.json that names the public host and port.
const env = {};
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    let v = trimmed.slice(eq + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    env[trimmed.slice(0, eq).trim()] = v;
  }
}

// settings.json is authoritative once the app has booted: the admin UI can
// change the custom domain and the listener port there, and printing the .env
// values would hand out a URL that no longer works.
const dataDir =
  process.env.EVERY_EAR_DATA_DIR ??
  env.EVERY_EAR_DATA_DIR ??
  path.join(projectRoot, "backend", "data");
let settings = {};
try {
  settings = JSON.parse(
    readFileSync(path.join(dataDir, "settings.json"), "utf8"),
  );
} catch {
  // No settings yet (fresh checkout / env-only install) — fall back to .env.
}

const host =
  (typeof settings.customDomain === "string" && settings.customDomain.trim()) ||
  settings.publicHost ||
  env.PUBLIC_HOST;
if (!host) {
  console.error("PUBLIC_HOST not set in .env and no public host in settings.json.");
  process.exit(1);
}

const rawPort = Number(settings.listenerPort ?? env.LISTENER_PORT ?? 8443);
const port = Number.isInteger(rawPort) && rawPort > 0 ? rawPort : 8443;
// 443 is the HTTPS default and must not be spelled out in the URL.
const authority = port === 443 ? host : `${host}:${port}`;

const url = `https://${authority}/`;
const translatorUrl = `https://${authority}/translator-login.html`;

console.log("");
console.log(`Listener URL:   ${url}`);
console.log(`Translator URL: ${translatorUrl}`);
console.log("");

try {
  const { default: qr } = await import("qrcode-terminal");
  console.log("Listener QR:");
  qr.generate(url, { small: true });
} catch {
  console.log(
    "(QR rendering needs qrcode-terminal — run `npm install` at the repo root)",
  );
}
