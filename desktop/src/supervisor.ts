// Supervises the three child processes: the Fastify backend, livekit-server and
// Caddy. The backend is started first — it owns the runtime Caddyfile and
// settings — then LiveKit and Caddy. Ports the patterns from scripts/dev.mjs
// (cross-platform spawn, per-line log piping, taskkill-on-Windows teardown).

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, renameSync, rmSync, statSync, type WriteStream } from "node:fs";
import path from "node:path";
import { loadSettings } from "./config-store";
import {
  backendCwd,
  backendEntry,
  binaryPath,
  defaultBackgroundPath,
  frontendDist,
  livekitConfigPath,
  logDir,
} from "./paths";

export type SupervisorEnv = {
  /** LAN address listeners connect to (also LiveKit's node-ip). */
  publicHost: string;
  /** TCP port Caddy binds for the listener-facing HTTPS server. */
  listenerPort: number;
  dataDir: string;
};

export type SupervisorStatus = "stopped" | "starting" | "running" | "stopping";

type ProcName = "backend" | "livekit" | "caddy";

type ProcSpec = {
  name: ProcName;
  cmd: string;
  args: string[];
  cwd: string;
  shell: boolean;
};

const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3000);

const STATE = {
  status: "stopped" as SupervisorStatus,
  children: [] as Array<{ name: ProcName; child: ChildProcess }>,
  logStreams: [] as WriteStream[],
  // Per-child restart accounting for bounded auto-restart.
  restarts: new Map<ProcName, { count: number; windowStart: number }>(),
  env: null as SupervisorEnv | null,
  restartTimers: new Set<NodeJS.Timeout>(),
};

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 5 * 60 * 1000;
const RESTART_BASE_MS = 1000;

export const events = new EventEmitter();

export function status(): SupervisorStatus {
  return STATE.status;
}

export async function start(env: SupervisorEnv): Promise<void> {
  if (STATE.status !== "stopped") {
    throw new Error(`supervisor.start: already ${STATE.status}`);
  }
  STATE.env = env;
  STATE.status = "starting";
  events.emit("status", STATE.status);

  const specs = buildSpecs(env);

  // Backend first — it writes the Caddyfile that Caddy will load.
  const backendSpec = specs.find((s) => s.name === "backend")!;
  STATE.children.push({ name: "backend", child: spawnChild(backendSpec, env) });
  await waitForBackend();

  const livekitSpec = specs.find((s) => s.name === "livekit")!;
  STATE.children.push({ name: "livekit", child: spawnChild(livekitSpec, env) });
  await sleep(250);

  const caddySpec = specs.find((s) => s.name === "caddy")!;
  STATE.children.push({ name: "caddy", child: spawnChild(caddySpec, env) });

  STATE.status = "running";
  events.emit("status", STATE.status);
}

export async function stop(): Promise<void> {
  if (STATE.status === "stopped") return;
  STATE.status = "stopping";
  events.emit("status", STATE.status);

  // Reverse order: caddy, livekit, backend.
  for (const entry of [...STATE.children].reverse()) {
    killChild(entry.name, entry.child);
  }

  for (const t of STATE.restartTimers) clearTimeout(t);
  STATE.restartTimers.clear();

  await sleep(1500);

  STATE.children = [];
  STATE.restarts.clear();
  for (const s of STATE.logStreams) s.end();
  STATE.logStreams = [];
  STATE.status = "stopped";
  events.emit("status", STATE.status);
}

export async function restart(env: SupervisorEnv): Promise<void> {
  await stop();
  await start(env);
}

function buildSpecs(env: SupervisorEnv): ProcSpec[] {
  const s = loadSettings();
  const caddyfile = path.join(env.dataDir, "Caddyfile");
  return [
    {
      name: "backend",
      cmd: process.execPath,
      args: [backendEntry()],
      cwd: backendCwd(),
      shell: false,
    },
    {
      name: "livekit",
      cmd: binaryPath("livekit-server"),
      args: [
        "--config",
        livekitConfigPath(),
        "--node-ip",
        env.publicHost,
        "--keys",
        `${s.livekitApiKey}: ${s.livekitApiSecret}`,
      ],
      cwd: backendCwd(),
      shell: false,
    },
    {
      name: "caddy",
      cmd: binaryPath("caddy"),
      args: ["run", "--config", caddyfile, "--adapter", "caddyfile"],
      cwd: backendCwd(),
      shell: false,
    },
  ];
}

function spawnChild(spec: ProcSpec, env: SupervisorEnv): ChildProcess {
  const s = loadSettings();
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LIVEKIT_API_KEY: s.livekitApiKey,
    LIVEKIT_API_SECRET: s.livekitApiSecret,
    ADMIN_PASSWORD: s.adminPassword,
    BACKEND_PORT: String(BACKEND_PORT),
    LISTENER_PORT: String(env.listenerPort),
    PUBLIC_HOST: env.publicHost,
    LIVEKIT_NODE_IP: env.publicHost,
    LANGUAGES: s.languages,
    EVERY_EAR_DATA_DIR: env.dataDir,
    EVERY_EAR_LOG_DIR: logDir(),
    EVERY_EAR_DEFAULT_BG: defaultBackgroundPath(),
    FRONTEND_DIST: frontendDist(),
    // The backend owns and live-reloads Caddy's config (desktop launcher).
    EVERY_EAR_MANAGE_CADDY: "1",
    // LiveKit webhooks → backend stats collector.
    LIVEKIT_WEBHOOK_API_KEY: s.livekitApiKey,
    LIVEKIT_WEBHOOK_URLS: `http://127.0.0.1:${BACKEND_PORT}/api/livekit/webhook`,
  };

  // The backend runs under the Electron binary as a plain Node process.
  if (spec.name === "backend") {
    childEnv.ELECTRON_RUN_AS_NODE = "1";
  }
  if (process.platform === "win32" && childEnv.PATH) {
    childEnv.Path = childEnv.PATH;
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    shell: spec.shell,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const logFile = path.join(logDir(), `${spec.name}.log`);
  // Cap the log file: rotate to a single .1 backup once it exceeds 10 MB, so a
  // host left running for days can't slowly fill its disk.
  try {
    if (statSync(logFile).size > 10 * 1024 * 1024) {
      rmSync(`${logFile}.1`, { force: true });
      renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    // No existing log file yet — nothing to rotate.
  }
  const logStream = createWriteStream(logFile, { flags: "a" });
  STATE.logStreams.push(logStream);

  child.stdout?.on("data", makeLineSink(spec.name, logStream, "stdout"));
  child.stderr?.on("data", makeLineSink(spec.name, logStream, "stderr"));

  child.on("error", (err) => {
    events.emit("error", { name: spec.name, error: err });
  });

  child.on("exit", (code, signal) => {
    events.emit("exit", { name: spec.name, code, signal });
    if (STATE.status !== "running") return; // expected exit during stop/restart
    scheduleRestart(spec, env);
  });

  return child;
}

function scheduleRestart(spec: ProcSpec, env: SupervisorEnv): void {
  const now = Date.now();
  let acct = STATE.restarts.get(spec.name);
  if (!acct) {
    acct = { count: 0, windowStart: now };
    STATE.restarts.set(spec.name, acct);
  }
  if (now - acct.windowStart > RESTART_WINDOW_MS) {
    acct.count = 0;
    acct.windowStart = now;
  }
  acct.count++;

  if (acct.count > MAX_RESTARTS) {
    events.emit("crash", {
      name: spec.name,
      code: null,
      signal: null,
      fatal: true,
      detail: `exceeded ${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s`,
    });
    return;
  }

  const attempt = acct.count;
  const backoff = Math.min(RESTART_BASE_MS * 2 ** (attempt - 1), 30_000);
  events.emit("crash", {
    name: spec.name,
    code: null,
    signal: null,
    fatal: false,
    detail: `restarting (attempt ${attempt}/${MAX_RESTARTS}) in ${backoff}ms`,
  });

  const timer = setTimeout(() => {
    STATE.restartTimers.delete(timer);
    if (STATE.status !== "running") return;
    const idx = STATE.children.findIndex((c) => c.name === spec.name);
    if (idx < 0) return;
    const child = spawnChild(spec, env);
    STATE.children[idx] = { name: spec.name, child };
  }, backoff);
  STATE.restartTimers.add(timer);
}

function makeLineSink(name: string, logStream: WriteStream, channel: "stdout" | "stderr") {
  let buf = "";
  return (chunk: Buffer | string) => {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      logStream.write(`${new Date().toISOString()} ${line}\n`);
      events.emit("log", { name, channel, line });
    }
  };
}

function killChild(_name: ProcName, child: ChildProcess): void {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // ignore
  }
}

async function waitForBackend(timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${BACKEND_PORT}/api/health`;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  // Proceed anyway — Caddy will retry and the backend crash handler will catch
  // a genuinely broken backend.
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
