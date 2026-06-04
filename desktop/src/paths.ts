// Resolves filesystem paths for both `electron .` (dev) and the packaged app.
// In dev, native binaries come from PATH and the backend / frontend / Caddy
// configs sit in the repo. In packaged mode, everything is under
// `process.resourcesPath` thanks to electron-builder's `extraResources`.

import { app } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

export const isPackaged: boolean = app.isPackaged;

export function resourcesDir(): string {
  if (isPackaged) return process.resourcesPath;
  // In dev, mirror the packaged layout enough that supervisor + Caddy keep
  // working: backend/frontend live under the repo, binaries on PATH.
  return repoRoot;
}

export function userDataDir(): string {
  return app.getPath("userData");
}

export function dataDir(): string {
  return path.join(userDataDir(), "data");
}

export function logDir(): string {
  return path.join(userDataDir(), "logs");
}

export function configFile(): string {
  return path.join(userDataDir(), "config.json");
}

function platformBinaryName(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * Resolve the LiveKit server / Caddy binary. In packaged mode the binary lives
 * under Resources/bin (electron-builder picks the right OS+arch flavour at
 * pack time). In dev we fall back to whatever is on PATH so brew-installed
 * binaries still work without a fetch step.
 */
export function binaryPath(name: "livekit-server" | "caddy"): string {
  const exeName = platformBinaryName(name);
  if (isPackaged) {
    return path.join(process.resourcesPath, "bin", exeName);
  }
  // Dev: check the bundled .bin first (populated by fetch-binaries), then PATH.
  const localBundled = path.join(repoRoot, "desktop", "resources", "bin", platformDir(), archDir(), exeName);
  if (existsSync(localBundled)) return localBundled;
  const repoBin = path.join(repoRoot, ".bin", exeName);
  if (existsSync(repoBin)) return repoBin;
  return name; // hand to PATH
}

function platformDir(): string {
  switch (process.platform) {
    case "darwin":
      return "mac";
    case "win32":
      return "win";
    case "linux":
      return "linux";
    default:
      return process.platform;
  }
}

function archDir(): string {
  return process.arch === "arm64" ? "arm64" : "x64";
}

export function backendEntry(): string {
  if (isPackaged) {
    return path.join(process.resourcesPath, "backend", "dist", "server.js");
  }
  return path.join(repoRoot, "backend", "dist", "server.js");
}

export function backendCwd(): string {
  return path.dirname(path.dirname(backendEntry()));
}

export function frontendDist(): string {
  if (isPackaged) {
    return path.join(process.resourcesPath, "frontend", "dist");
  }
  return path.join(repoRoot, "frontend", "dist");
}

export function caddyfilePath(): string {
  if (isPackaged) return path.join(process.resourcesPath, "Caddyfile");
  return path.join(repoRoot, "desktop", "resources", "Caddyfile.tmpl");
}

/** Runtime-generated Caddyfile written before each supervisor start. */
export function generatedCaddyfilePath(): string {
  return path.join(userDataDir(), "Caddyfile");
}

/** Where Caddy stores its internal CA and ACME certificates. */
export function caddyStorageDir(): string {
  return path.join(userDataDir(), "caddy-data");
}

export function livekitConfigPath(): string {
  if (isPackaged) return path.join(process.resourcesPath, "livekit.yaml");
  return path.join(repoRoot, "livekit.yaml");
}

export function defaultBackgroundPath(): string {
  return path.join(frontendDist(), "bg.jpg");
}

export function acmeCertsDir(): string {
  return path.join(userDataDir(), "acme-certs");
}

export function acmeAccountKeyPath(): string {
  return path.join(userDataDir(), "acme-account.pem");
}

export function rendererHtmlPath(): string {
  return path.join(__dirname, "renderer", "settings.html");
}

export function preloadPath(): string {
  return path.join(__dirname, "preload.js");
}
