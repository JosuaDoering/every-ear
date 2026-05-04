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

if (!existsSync(envPath)) {
  console.error(`No .env at ${envPath}. Run the install script first.`);
  process.exit(1);
}

const env = {};
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

const host = env.PUBLIC_HOST;
if (!host) {
  console.error("PUBLIC_HOST not set in .env.");
  process.exit(1);
}

const url = `https://${host}/`;
const translatorUrl = `https://${host}/translator.html`;

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
