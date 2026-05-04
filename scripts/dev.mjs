#!/usr/bin/env node
// Cross-platform dev orchestrator: starts livekit-server, the backend,
// the frontend, and Caddy as a single foreground process. Used by
// scripts/start.sh (macOS fallback) and scripts/start.ps1 (Windows).

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const envPath = path.join(projectRoot, ".env");

if (!existsSync(envPath)) {
  console.error(`Missing .env in ${projectRoot}.`);
  console.error(
    `Run scripts/install-mac.sh (macOS) or scripts/install-windows.ps1 (Windows) first.`,
  );
  process.exit(1);
}

function parseEnv(file) {
  const text = readFileSync(file, "utf8");
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const env = { ...process.env, ...parseEnv(envPath) };

function requireVar(name) {
  if (!env[name]) {
    console.error(`Missing required env var ${name} in .env.`);
    process.exit(1);
  }
  return env[name];
}

const NODE_IP = requireVar("LIVEKIT_NODE_IP");
const API_KEY = requireVar("LIVEKIT_API_KEY");
const API_SECRET = requireVar("LIVEKIT_API_SECRET");

// On Windows, the LiveKit server binary is dropped into ./.bin by the
// installer. Add it to PATH for this process tree so livekit-server resolves.
const localBin = path.join(projectRoot, ".bin");
if (existsSync(localBin)) {
  env.PATH = `${localBin}${path.delimiter}${env.PATH ?? ""}`;
  if (process.platform === "win32") {
    env.Path = env.PATH;
  }
}

const procs = [
  {
    name: "livekit",
    cmd: "livekit-server",
    args: [
      "--config",
      "livekit.yaml",
      "--node-ip",
      NODE_IP,
      "--keys",
      `${API_KEY}: ${API_SECRET}`,
    ],
  },
  {
    name: "backend",
    cmd: "npm",
    args: ["--prefix", "backend", "run", "dev"],
  },
  {
    name: "frontend",
    cmd: "npm",
    args: ["--prefix", "frontend", "run", "dev", "--", "--host", "0.0.0.0"],
  },
  {
    name: "caddy",
    cmd: "caddy",
    args: ["run", "--config", "Caddyfile", "--adapter", "caddyfile"],
  },
];

const PALETTE = ["\x1b[36m", "\x1b[35m", "\x1b[33m", "\x1b[32m"];
const RESET = "\x1b[0m";

const children = [];
let shuttingDown = false;

function makeLineWriter(prefix, sink) {
  let buf = "";
  return (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      sink.write(`${prefix} ${line}\n`);
    }
  };
}

procs.forEach((p, i) => {
  const prefix = `${PALETTE[i % PALETTE.length]}[${p.name.padEnd(8)}]${RESET}`;
  console.log(`${prefix} starting: ${p.cmd} ${p.args.join(" ")}`);

  const child = spawn(p.cmd, p.args, {
    cwd: projectRoot,
    env,
    // shell:true is required on Windows so npm.cmd / caddy.exe / etc. resolve
    // off of PATH the same way as in cmd.exe. It's harmless on macOS.
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", makeLineWriter(prefix, process.stdout));
  child.stderr.on("data", makeLineWriter(prefix, process.stderr));

  child.on("error", (err) => {
    console.error(`${prefix} failed to start: ${err.message}`);
    if (err.code === "ENOENT") {
      console.error(
        `${prefix} -> "${p.cmd}" not found in PATH. Install it first ` +
          `(see scripts/install-mac.sh or scripts/install-windows.ps1).`,
      );
    }
    shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (!shuttingDown) {
      console.log(`${prefix} exited (code=${code}, signal=${signal})`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
});

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) {
    if (!c || c.killed) continue;
    try {
      if (process.platform === "win32") {
        // Tear down the whole tree (npm spawns sub-shells on Windows).
        spawn("taskkill", ["/pid", String(c.pid), "/t", "/f"], {
          stdio: "ignore",
        });
      } else {
        c.kill("SIGTERM");
      }
    } catch {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(code), 1500);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
