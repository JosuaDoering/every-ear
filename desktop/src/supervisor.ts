// Supervises the three child processes: livekit-server, the Fastify backend,
// and Caddy. Ports the patterns from scripts/dev.mjs (cross-platform spawn,
// per-line log piping, taskkill-on-Windows teardown) but resolves binaries
// from paths.ts and runs the backend through `ELECTRON_RUN_AS_NODE`.

import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, writeFileSync, type WriteStream } from "node:fs";
import path from "node:path";
import {
  backendCwd,
  backendEntry,
  binaryPath,
  caddyStorageDir,
  defaultBackgroundPath,
  frontendDist,
  generatedCaddyfilePath,
  livekitConfigPath,
  logDir,
} from "./paths";

export type SupervisorEnv = {
  livekitApiKey: string;
  livekitApiSecret: string;
  adminPassword: string;
  publicHost: string;
  /** TCP port Caddy binds for the listener-facing HTTPS server. */
  listenerPort: number;
  languages: string;
  dataDir: string;
  /** Optional custom domain for the Caddy host binding (overrides publicHost). */
  customDomain: string | null;
  /** Path to a PEM TLS certificate file; paired with customKeyFile. */
  customCertFile: string | null;
  /** Path to a PEM TLS private key file; paired with customCertFile. */
  customKeyFile: string | null;
};

export type SupervisorStatus = "stopped" | "starting" | "running" | "stopping";

type ProcSpec = {
  name: "livekit" | "backend" | "caddy";
  cmd: string;
  args: string[];
  cwd: string;
  shell: boolean;
};

const STATE = {
  status: "stopped" as SupervisorStatus,
  children: [] as Array<{ name: ProcSpec["name"]; child: ChildProcess }>,
  logStreams: [] as WriteStream[],
};

export const events = new EventEmitter();

export function status(): SupervisorStatus {
  return STATE.status;
}

function generateCaddyfileContent(env: SupervisorEnv): string {
  const port = env.listenerPort;
  const dist = frontendDist().replace(/\\/g, "/");
  const storage = caddyStorageDir().replace(/\\/g, "/");
  const customDomain = env.customDomain?.trim();
  const hasCustomCert = Boolean(env.customCertFile && env.customKeyFile);

  // Site blocks: when a custom domain + cert are configured, we keep that as
  // the primary block (real TLS for the domain) and add a second block for
  // direct LAN-IP access using Caddy's internal CA. Without that second
  // block, https://<lan-ip>:8443/ fails the TLS handshake because Caddy
  // has no matching server-block for the IP host header.
  const lines: string[] = [];
  // Shared access log so we can see incoming requests with source IP — vital
  // when diagnosing "can't reach the server" issues from client devices.
  const accessLog = [
    `\tlog {`,
    `\t\toutput file "${path.join(logDir(), "access.log").replace(/\\/g, "/")}" {`,
    `\t\t\troll_size 10mb`,
    `\t\t\troll_keep 3`,
    `\t\t}`,
    `\t}`,
  ];

  lines.push(
    // Global options: redirect Caddy's PKI/cert storage into our userData,
    // never share with a system Caddy install. Also disable HTTP/3 — its
    // UDP transport gets blocked or mishandled by carrier NATs, captive
    // portals, and event WiFi firewalls, producing ERR_QUIC_PROTOCOL_ERROR
    // on clients with no clean TCP fallback.
    `{`,
    `\tstorage file_system {`,
    `\t\troot "${storage}"`,
    `\t}`,
    `\tservers {`,
    `\t\tprotocols h1 h2`,
    `\t}`,
    `}`,
    ``,
    // Shared handlers — every site block imports this.
    `(handlers) {`,
    `\thandle_path /livekit/* {`,
    `\t\treverse_proxy localhost:7880`,
    `\t}`,
    `\thandle /api/* {`,
    `\t\treverse_proxy localhost:3000`,
    `\t}`,
    `\thandle {`,
    `\t\troot * "${dist}"`,
    `\t\ttry_files {path} /index.html`,
    `\t\tfile_server`,
    `\t}`,
    `}`,
    ``,
  );

  if (customDomain && hasCustomCert) {
    const certFile = env.customCertFile!.replace(/\\/g, "/");
    const keyFile = env.customKeyFile!.replace(/\\/g, "/");
    lines.push(
      `${customDomain}:${port}, localhost:${port} {`,
      `\ttls "${certFile}" "${keyFile}"`,
      `\timport handlers`,
      ...accessLog,
      `}`,
      ``,
      `${env.publicHost}:${port} {`,
      `\ttls internal`,
      `\timport handlers`,
      ...accessLog,
      `}`,
      ``,
    );
  } else {
    const host = customDomain || env.publicHost;
    lines.push(
      `${host}:${port}, ${env.publicHost}:${port}, localhost:${port} {`,
      `\ttls internal`,
      `\timport handlers`,
      ...accessLog,
      `}`,
      ``,
    );
  }

  return lines.join("\n");
}

export async function start(env: SupervisorEnv): Promise<void> {
  if (STATE.status !== "stopped") {
    throw new Error(`supervisor.start: already ${STATE.status}`);
  }
  STATE.status = "starting";
  events.emit("status", STATE.status);

  writeFileSync(generatedCaddyfilePath(), generateCaddyfileContent(env), "utf8");

  const procs = buildSpecs(env);

  for (const spec of procs) {
    const child = spawnChild(spec, env);
    STATE.children.push({ name: spec.name, child });
    // Small gap between starts — Caddy benefits from livekit + backend being
    // up first, but blocking on log lines makes the code fragile. 250ms is
    // plenty for a same-host startup race in practice.
    await sleep(250);
  }

  STATE.status = "running";
  events.emit("status", STATE.status);
}

export async function stop(): Promise<void> {
  if (STATE.status === "stopped") return;
  STATE.status = "stopping";
  events.emit("status", STATE.status);

  // Reverse order: caddy first, then backend, then livekit.
  for (const entry of [...STATE.children].reverse()) {
    killChild(entry.name, entry.child);
  }

  // Give the children a brief grace period to exit cleanly.
  await sleep(1500);

  STATE.children = [];
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
  return [
    {
      name: "livekit",
      cmd: binaryPath("livekit-server"),
      args: [
        "--config",
        livekitConfigPath(),
        "--node-ip",
        env.publicHost,
        "--keys",
        `${env.livekitApiKey}: ${env.livekitApiSecret}`,
      ],
      cwd: backendCwd(),
      shell: false,
    },
    {
      name: "backend",
      cmd: process.execPath,
      args: [backendEntry()],
      cwd: backendCwd(),
      shell: false,
    },
    {
      name: "caddy",
      cmd: binaryPath("caddy"),
      args: ["run", "--config", generatedCaddyfilePath(), "--adapter", "caddyfile"],
      cwd: backendCwd(),
      shell: false,
    },
  ];
}

function spawnChild(spec: ProcSpec, env: SupervisorEnv): ChildProcess {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LIVEKIT_API_KEY: env.livekitApiKey,
    LIVEKIT_API_SECRET: env.livekitApiSecret,
    ADMIN_PASSWORD: env.adminPassword,
    BACKEND_PORT: "3000",
    LISTENER_PORT: String(env.listenerPort),
    PUBLIC_HOST: env.publicHost,
    LIVEKIT_NODE_IP: env.publicHost,
    LANGUAGES: env.languages,
    EVERY_EAR_DATA_DIR: env.dataDir,
    EVERY_EAR_DEFAULT_BG: defaultBackgroundPath(),
    FRONTEND_DIST: frontendDist(),
  };

  // The backend runs under the Electron binary as a plain Node process.
  if (spec.name === "backend") {
    childEnv.ELECTRON_RUN_AS_NODE = "1";
  }

  // On Windows we set both Path and PATH to be safe.
  if (process.platform === "win32" && childEnv.PATH) {
    childEnv.Path = childEnv.PATH;
  }

  const child = spawn(spec.cmd, spec.args, {
    cwd: spec.cwd,
    env: childEnv,
    shell: spec.shell || (process.platform === "win32" && spec.name === "backend" ? false : false),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const logFile = path.join(logDir(), `${spec.name}.log`);
  const logStream = createWriteStream(logFile, { flags: "a" });
  STATE.logStreams.push(logStream);

  child.stdout?.on("data", makeLineSink(spec.name, logStream, "stdout"));
  child.stderr?.on("data", makeLineSink(spec.name, logStream, "stderr"));

  child.on("error", (err) => {
    events.emit("error", { name: spec.name, error: err });
  });

  child.on("exit", (code, signal) => {
    events.emit("exit", { name: spec.name, code, signal });
    if (STATE.status === "running") {
      // Unexpected crash. Surface it; main process decides whether to
      // notify the user. Don't auto-restart — that hides bugs.
      events.emit("crash", { name: spec.name, code, signal });
    }
  });

  return child;
}

function makeLineSink(
  name: string,
  logStream: WriteStream,
  channel: "stdout" | "stderr",
) {
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

function killChild(_name: ProcSpec["name"], child: ChildProcess): void {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32" && typeof child.pid === "number") {
      // npm / shell wrappers leave grandchildren behind on Windows. taskkill
      // /T tears down the whole tree; /F is a hard kill but we already gave
      // the OS a beat with the grace sleep above.
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
