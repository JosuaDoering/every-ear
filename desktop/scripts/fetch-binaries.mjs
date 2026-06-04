// Downloads / builds the LiveKit server + Caddy native binaries into
// desktop/resources/bin/<os>/<arch>/ for every arch electron-builder will
// produce on this host. electron-builder ships the per-arch directory as
// `extraResources` (the matching arch is selected at pack time).
//
// macOS specifics: LiveKit doesn't publish prebuilt darwin binaries
// (Homebrew compiles from source). Strategy per arch:
//   * Host arch with a Homebrew livekit on disk → copy that binary.
//   * Otherwise (or for the cross-arch slice) build with `go build`.
//     Cross-compiling between mac arm64 ↔ x64 is first-class in Go.
//
// Linux + Windows: download the official release asset.

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { copyFile, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const LIVEKIT_VERSION = "v1.11.0";
const CADDY_VERSION   = "v2.8.4";

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");

const platform = process.platform;            // 'darwin' | 'win32' | 'linux'
const platformDir = ({ darwin: "mac", win32: "win", linux: "linux" })[platform] ?? platform;

// Which arches should we populate?
//
// macOS:    arm64 only by default. x64 needs CGO cross-compile (LiveKit's
//           cpu-stats package depends on CGO), which means installing a
//           C cross-toolchain. Most current Macs are Apple Silicon — opt
//           into x64 explicitly with `EVERY_EAR_MAC_ARCHS=arm64,x64`.
// Windows:  x64 only (default Windows 11 install).
// Linux:    x64 only.
const targetArchs = (() => {
  if (platform === "darwin") {
    const fromEnv = process.env.EVERY_EAR_MAC_ARCHS;
    if (fromEnv) return fromEnv.split(",").map((s) => s.trim()).filter(Boolean);
    return ["arm64"];
  }
  return ["x64"];
})();

console.log(`→ Fetching binaries for ${platformDir} archs: ${targetArchs.join(", ")}`);

for (const arch of targetArchs) {
  const targetDir = path.join(desktopRoot, "resources", "bin", platformDir, arch);
  mkdirSync(targetDir, { recursive: true });
  console.log(`\n  ── ${platformDir}/${arch} ──`);
  await ensureLiveKit(arch, targetDir);
  await ensureCaddy(arch, targetDir);
}

console.log("\n✓ Done.");

// ---- LiveKit ---------------------------------------------------------------

async function ensureLiveKit(arch, targetDir) {
  const exe = exeName("livekit-server");
  const dst = path.join(targetDir, exe);
  if (existsSync(dst)) {
    console.log(`  livekit-server already present`);
    return;
  }

  if (platform === "darwin") {
    await ensureLiveKitMac(arch, dst);
    return;
  }

  // Linux + Windows: download the release asset.
  const lkPlatform = platform === "win32" ? "windows" : "linux";
  const lkArch = arch === "arm64" ? "arm64" : "amd64";
  const lkExt  = platform === "win32" ? "zip" : "tar.gz";
  const versionNoV = LIVEKIT_VERSION.replace(/^v/, "");

  const file = `livekit_${versionNoV}_${lkPlatform}_${lkArch}.${lkExt}`;
  const url = `https://github.com/livekit/livekit/releases/download/${LIVEKIT_VERSION}/${file}`;

  console.log(`  livekit-server ← ${url}`);
  const tmp = await downloadToTemp(url, file);
  if (lkExt === "zip") await unzipInto(tmp.archive, tmp.dir);
  else await untarInto(tmp.archive, tmp.dir);

  const inner = await findInTree(tmp.dir, exe);
  if (!inner) throw new Error(`Could not find ${exe} in ${tmp.dir}`);
  renameSync(inner, dst);
  await tmp.cleanup();
  if (platform !== "win32") await execFileAsync("chmod", ["+x", dst]);
}

async function ensureLiveKitMac(arch, dst) {
  const isHostArch = arch === process.arch;

  if (isHostArch) {
    // 1) Prefer the canonical Cellar path for the pinned version.
    const cellarBin = `/opt/homebrew/Cellar/livekit/${LIVEKIT_VERSION.replace(/^v/, "")}/bin/livekit-server`;
    if (await isFile(cellarBin)) {
      console.log(`  livekit-server ← ${cellarBin} (Homebrew, pinned version)`);
      await copyExecutable(cellarBin, dst);
      return;
    }
    // 2) Any Homebrew install on this Mac.
    for (const candidate of [
      "/opt/homebrew/bin/livekit-server",
      "/usr/local/bin/livekit-server",
    ]) {
      if (await isFile(candidate)) {
        const real = await realPath(candidate);
        console.log(`  livekit-server ← ${real} (Homebrew)`);
        await copyExecutable(real, dst);
        return;
      }
    }
  }

  // Cross-arch slice (or no brew on host) → compile from source.
  if (!(await hasCommand("go"))) {
    throw new Error(
      `LiveKit doesn't publish prebuilt macOS binaries, and Go isn't on PATH.\n` +
      `Either:\n` +
      `  • brew install go     (the script will compile from source)\n` +
      `  • brew install livekit  (host-arch slice can be copied from Homebrew)`,
    );
  }
  await buildLiveKitFromSource(arch, dst);
}

async function buildLiveKitFromSource(arch, dst) {
  const tag = LIVEKIT_VERSION;
  const versionNoV = tag.replace(/^v/, "");
  const tarball = `https://github.com/livekit/livekit/archive/refs/tags/${tag}.tar.gz`;

  // Cache the source tree across arches so we extract once, not twice.
  const cachedSrcDir = path.join(desktopRoot, ".cache", `livekit-${versionNoV}`);
  if (!existsSync(cachedSrcDir)) {
    console.log(`  livekit-server ← downloading source ${tag}…`);
    const tmp = await downloadToTemp(tarball, `livekit-${tag}.tar.gz`);
    await untarInto(tmp.archive, tmp.dir);
    const extracted = path.join(tmp.dir, `livekit-${versionNoV}`);
    if (!existsSync(extracted)) {
      throw new Error(`Expected source tree at ${extracted}`);
    }
    mkdirSync(path.dirname(cachedSrcDir), { recursive: true });
    renameSync(extracted, cachedSrcDir);
    await tmp.cleanup();
  }

  const goarch = arch === "arm64" ? "arm64" : "amd64";
  console.log(`  livekit-server ← go build GOOS=darwin GOARCH=${goarch}…`);
  await execFileAsync(
    "go",
    ["build", "-trimpath", "-ldflags=-s -w", "-o", dst, "./cmd/server"],
    {
      cwd: cachedSrcDir,
      env: { ...process.env, GOOS: "darwin", GOARCH: goarch, CGO_ENABLED: "0" },
    },
  );
  await execFileAsync("chmod", ["+x", dst]);
}

// ---- Caddy -----------------------------------------------------------------

async function ensureCaddy(arch, targetDir) {
  const exe = exeName("caddy");
  const dst = path.join(targetDir, exe);
  if (existsSync(dst)) {
    console.log(`  caddy already present`);
    return;
  }

  const caddyPlatform =
    platform === "darwin" ? "mac" :
    platform === "win32"  ? "windows" :
                            "linux";
  const caddyArch = arch === "arm64" ? "arm64" : "amd64";
  const versionNoV = CADDY_VERSION.replace(/^v/, "");
  const ext = platform === "win32" ? "zip" : "tar.gz";
  const file = `caddy_${versionNoV}_${caddyPlatform}_${caddyArch}.${ext}`;
  const url = `https://github.com/caddyserver/caddy/releases/download/${CADDY_VERSION}/${file}`;

  console.log(`  caddy ← ${url}`);
  const tmp = await downloadToTemp(url, file);
  if (ext === "zip") await unzipInto(tmp.archive, tmp.dir);
  else await untarInto(tmp.archive, tmp.dir);

  const inner = await findInTree(tmp.dir, exe);
  if (!inner) throw new Error(`Could not find ${exe} in ${tmp.dir}`);
  renameSync(inner, dst);
  await tmp.cleanup();
  if (platform !== "win32") await execFileAsync("chmod", ["+x", dst]);
}

// ---- helpers ---------------------------------------------------------------

function exeName(name) {
  return platform === "win32" ? `${name}.exe` : name;
}

async function downloadToTemp(url, archiveName) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "every-ear-"));
  const archive = path.join(dir, archiveName);

  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: ${url} (HTTP ${res.status})`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));

  return {
    dir,
    archive,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function unzipInto(archive, intoDir) {
  if (platform === "win32") {
    await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Expand-Archive -Path '${archive}' -DestinationPath '${intoDir}' -Force`,
    ]);
  } else {
    await execFileAsync("unzip", ["-o", "-q", archive, "-d", intoDir]);
  }
}

async function untarInto(archive, intoDir) {
  await execFileAsync("tar", ["-xzf", archive, "-C", intoDir]);
}

/** Recursively search a directory tree for a file named exactly `target`. */
async function findInTree(root, target) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name === target) return full;
    }
  }
  return null;
}

async function isFile(p) {
  try {
    const s = await stat(p);
    return s.isFile() || s.isSymbolicLink();
  } catch {
    return false;
  }
}

async function realPath(p) {
  // Symlink-resolve so we copy the actual binary, not a dangling reference.
  const { stdout } = await execFileAsync("/usr/bin/readlink", ["-f", p]).catch(
    () => ({ stdout: p }),
  );
  return stdout.trim() || p;
}

async function copyExecutable(src, dst) {
  await copyFile(src, dst);
  if (platform !== "win32") await execFileAsync("chmod", ["+x", dst]);
}

async function hasCommand(cmd) {
  try {
    await execFileAsync(platform === "win32" ? "where" : "/usr/bin/which", [cmd]);
    return true;
  } catch {
    return false;
  }
}
