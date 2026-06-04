// macOS-only: detect whether the system Application Firewall is blocking
// our livekit-server binary. If it is, WebRTC media traffic (audio) can't
// reach the host and audio start/broadcast silently fail on clients.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { binaryPath } from "./paths";

const exec = promisify(execFile);
const SOCKETFILTERFW = "/usr/libexec/ApplicationFirewall/socketfilterfw";

export type FirewallStatus = {
  /** Human-readable warning, or null if everything's fine / check N/A. */
  warning: string | null;
  /** Absolute path of the binary that needs allowing, for the "open Firewall" UX. */
  binaryPath: string | null;
};

let cache: FirewallStatus = { warning: null, binaryPath: null };

export async function refresh(): Promise<FirewallStatus> {
  if (process.platform !== "darwin") {
    cache = { warning: null, binaryPath: null };
    return cache;
  }

  let lkPath = binaryPath("livekit-server");
  if (!path.isAbsolute(lkPath)) {
    try {
      const { stdout } = await exec("/usr/bin/which", [lkPath]);
      lkPath = stdout.trim();
    } catch {
      cache = { warning: null, binaryPath: null };
      return cache;
    }
  }

  try {
    const { stdout: state } = await exec(SOCKETFILTERFW, ["--getglobalstate"]);
    if (!/State = [12]/.test(state)) {
      // Firewall is disabled — nothing to warn about.
      cache = { warning: null, binaryPath: lkPath };
      return cache;
    }

    const { stdout } = await exec(SOCKETFILTERFW, ["--getappblocked", lkPath]);
    if (/blocking incoming connections/i.test(stdout)) {
      cache = {
        warning:
          "The macOS Firewall is blocking livekit-server. Audio can't be sent or received from devices on the network. Open Firewall settings and allow incoming connections for the binary below.",
        binaryPath: lkPath,
      };
      return cache;
    }
  } catch (err) {
    console.error("[firewall-check]", err);
  }

  cache = { warning: null, binaryPath: lkPath };
  return cache;
}

export function getCached(): FirewallStatus {
  return cache;
}
