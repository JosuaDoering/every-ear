// Owns the runtime Caddyfile and reloads Caddy live via its admin API.
//
// Putting Caddy config generation in the backend means a domain/certificate or
// listener-port change from the web admin takes effect immediately (no restart,
// desktop or headless). The launcher only has to start Caddy pointing at this
// file; the backend rewrites and reloads it whenever settings change.

import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { isValidHost, getSettings } from "./settings.js";
import { CONTENT_SECURITY_POLICY, SECURITY_HEADERS } from "./security-headers.js";
import { writeAtomicSync } from "./store.js";

export const caddyfilePath = path.join(config.dataDir, "Caddyfile");

const CADDY_ADMIN = process.env.CADDY_ADMIN ?? "http://127.0.0.1:2019";

// Only reload Caddy's running config when the launcher has opted in. In Vite
// dev mode Caddy is configured by hand (proxying to the dev server), so the
// backend must not hijack it.
function managesCaddy(): boolean {
  return process.env.EVERY_EAR_MANAGE_CADDY === "1";
}

function slash(p: string): string {
  return p.replace(/\\/g, "/");
}

/**
 * A site address that is safe to emit. Domain changes are validated strictly on
 * write, but `publicHost` may come from the installer or a hand-edited
 * settings.json, so check it here too: no whitespace, braces, quotes or
 * newlines may reach the Caddyfile. Single-label names (e.g. "raspberrypi") are
 * allowed — they are legal Caddy site addresses and the installer prints URLs
 * for them.
 */
const SITE_ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function siteHost(value: string | null | undefined): string {
  const host = value?.trim();
  if (!host || host === "localhost") return "localhost";
  if (!SITE_ADDRESS_RE.test(host)) {
    console.error("[caddy] ignoring invalid site host:", JSON.stringify(host));
    return "localhost";
  }
  return host;
}

export function generateCaddyfile(): string {
  const s = getSettings();
  const port = s.listenerPort;
  const rawDomain = s.customDomain?.trim() || "";
  const domain = rawDomain && isValidHost(rawDomain) ? rawDomain : "";
  // A certificate path that no longer exists (removed certs/ dir, restored
  // settings.json) would make Caddy refuse to start at all, taking the whole
  // site down. Fall back to the internal CA instead; the admin sees the
  // resulting browser warning and can re-issue or re-upload.
  const certMissing =
    Boolean(s.customCertFile && s.customKeyFile) &&
    !(existsSync(s.customCertFile!) && existsSync(s.customKeyFile!));
  if (certMissing) {
    console.error(
      "[caddy] custom certificate files are missing, using internal CA:",
      s.customCertFile,
      s.customKeyFile,
    );
  }
  const hasCert = Boolean(domain && s.customCertFile && s.customKeyFile) && !certMissing;
  const host = siteHost(domain || s.publicHost);
  const dist = slash(config.frontendDist);
  const dataDir = slash(config.dataDir);
  const logDir = slash(config.logDir);

  // Emit the same header policy the backend applies, so the UI is hardened no
  // matter which server answers (Caddy in production, Fastify on loopback).
  const headerLines = Object.entries({
    ...SECURITY_HEADERS,
    "Content-Security-Policy": CONTENT_SECURITY_POLICY,
  }).map(([name, value]) => `\theader ${name} "${value}"`);

  const handlers = [
    "(handlers) {",
    ...headerLines,
    "\thandle_path /livekit/* {",
    "\t\treverse_proxy localhost:7880",
    "\t}",
    // `/api` alone is not matched by `/api/*`; without it the bare path falls
    // through to the SPA route and answers HTML instead of the backend's 404.
    // `handle` takes only one matcher, hence the named matcher set.
    "\t@api path /api /api/*",
    "\thandle @api {",
    `\t\treverse_proxy localhost:${config.port}`,
    "\t}",
    "\thandle {",
    `\t\troot * "${dist}"`,
    // A path containing a dot is a real file: serve it as-is (404 when it is
    // missing) instead of answering a stale /assets/*.js request with
    // index.html, which surfaces as a MIME/syntax error in the browser.
    "\t\t@asset path *.*",
    "\t\thandle @asset {",
    "\t\t\tfile_server",
    "\t\t}",
    "\t\thandle {",
    "\t\t\ttry_files {path} /index.html",
    "\t\t\tfile_server",
    "\t\t}",
    "\t}",
    "}",
  ];

  const log = [
    "\tlog {",
    `\t\toutput file "${logDir}/access.log" {`,
    "\t\t\troll_size 10mb",
    "\t\t\troll_keep 3",
    "\t\t}",
    "\t}",
  ];

  const lines: string[] = [
    "{",
    "\tstorage file_system {",
    `\t\troot "${dataDir}/caddy-data"`,
    "\t}",
    "\tservers {",
    "\t\t# HTTP/3 (QUIC) is frequently blocked on event WiFi; force TCP.",
    "\t\tprotocols h1 h2",
    "\t}",
    "\tadmin 127.0.0.1:2019",
    "\tmetrics",
    "}",
    "",
    ...handlers,
    "",
  ];

  if (hasCert) {
    // Real certificate for the custom domain, internal CA for loopback and the
    // LAN IP so the admin UI never presents a mismatched cert on localhost.
    lines.push(
      `${domain}:${port} {`,
      `\ttls "${slash(s.customCertFile!)}" "${slash(s.customKeyFile!)}"`,
      // Only offered for the public domain: browsers cache HSTS for the host,
      // which would break the internal-CA variants and plain-http LAN access.
      "\theader Strict-Transport-Security \"max-age=31536000\"",
      "\timport handlers",
      ...log,
      "}",
      "",
      `localhost:${port}, 127.0.0.1:${port} {`,
      "\ttls internal",
      "\timport handlers",
      "}",
      "",
    );
    if (host !== domain && host !== "localhost" && host !== "127.0.0.1") {
      lines.push(
        `${host}:${port} {`,
        "\ttls internal",
        "\timport handlers",
        "}",
        "",
      );
    }
  } else {
    const hosts = Array.from(new Set([host, "localhost", "127.0.0.1"]));
    const site = hosts.map((h) => `${h}:${port}`).join(", ");
    lines.push(
      `${site} {`,
      "\ttls internal",
      "\timport handlers",
      ...log,
      "}",
      "",
    );
  }

  return lines.join("\n");
}

/** Write the Caddyfile to disk (used on cold start). */
export function writeCaddyfile(): void {
  writeAtomicSync(caddyfilePath, generateCaddyfile());
}

/**
 * Rewrite the Caddyfile and ask the running Caddy to load it. Returns true if
 * Caddy accepted it. Safe to call before Caddy is up (returns false; the file
 * on disk is used when the launcher starts Caddy).
 *
 * Caddy is asked *first*: a rejected config (e.g. a certificate path that does
 * not exist) must not be left on disk, otherwise the next Caddy start would
 * fail and take the whole site down.
 */
export async function reloadCaddy(): Promise<boolean> {
  // In Vite dev mode Caddy is managed by hand; nothing to reload here.
  if (!managesCaddy()) return true;
  const caddyfile = generateCaddyfile();

  let res: Response | null = null;
  try {
    res = await fetch(`${CADDY_ADMIN}/load`, {
      method: "POST",
      headers: {
        "Content-Type": "text/caddyfile",
        // Caddy >= 2.10 enforces the admin API origin check. Without this the
        // request is rejected with 403 even on loopback.
        Origin: CADDY_ADMIN,
      },
      body: caddyfile,
    });
  } catch (err) {
    // Caddy is not running (yet). Keep the new file so the next start uses it.
    console.error("[caddy] reload error:", err);
  }

  if (res && !res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[caddy] reload failed:", res.status, text.slice(0, 300));
    return false;
  }

  try {
    writeAtomicSync(caddyfilePath, caddyfile);
  } catch (err) {
    console.error("[caddy] failed to write Caddyfile:", err);
  }
  return res !== null;
}
