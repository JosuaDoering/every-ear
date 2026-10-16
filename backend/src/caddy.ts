// Owns the runtime Caddyfile and reloads Caddy live via its admin API.
//
// Putting Caddy config generation in the backend means a domain/certificate or
// listener-port change from the web admin takes effect immediately (no restart,
// desktop or headless). The launcher only has to start Caddy pointing at this
// file; the backend rewrites and reloads it whenever settings change.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { getSettings } from "./settings.js";

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

export function generateCaddyfile(): string {
  const s = getSettings();
  const port = s.listenerPort;
  const domain = s.customDomain?.trim() || "";
  const hasCert = Boolean(domain && s.customCertFile && s.customKeyFile);
  const host = domain || s.publicHost?.trim() || "localhost";
  const dist = slash(config.frontendDist);
  const dataDir = slash(config.dataDir);
  const logDir = slash(config.logDir);

  const handlers = [
    "(handlers) {",
    "\thandle_path /livekit/* {",
    "\t\treverse_proxy localhost:7880",
    "\t}",
    "\thandle /api/* {",
    `\t\treverse_proxy localhost:${config.port}`,
    "\t}",
    "\thandle {",
    `\t\troot * "${dist}"`,
    "\t\ttry_files {path} /index.html",
    "\t\tfile_server",
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
  writeFileSync(caddyfilePath, generateCaddyfile(), "utf8");
}

/**
 * Rewrite the Caddyfile and ask the running Caddy to load it. Returns true if
 * Caddy accepted it. Safe to call before Caddy is up (returns false; the file
 * on disk is used when the launcher starts Caddy).
 */
export async function reloadCaddy(): Promise<boolean> {
  if (!managesCaddy()) return false;
  const caddyfile = generateCaddyfile();
  try {
    writeFileSync(caddyfilePath, caddyfile, "utf8");
  } catch (err) {
    console.error("[caddy] failed to write Caddyfile:", err);
  }
  try {
    const res = await fetch(`${CADDY_ADMIN}/load`, {
      method: "POST",
      headers: { "Content-Type": "text/caddyfile" },
      body: caddyfile,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error("[caddy] reload failed:", res.status, text.slice(0, 300));
      return false;
    }
    return true;
  } catch (err) {
    console.error("[caddy] reload error:", err);
    return false;
  }
}
