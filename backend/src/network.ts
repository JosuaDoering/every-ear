// LAN-IP detection for the web admin's interface picker.
// Ported from desktop/src/network.ts (interface metric on Windows, `route` on
// macOS, `ip route` on Linux).

import { execFile } from "node:child_process";
import { networkInterfaces } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type LanCandidate = {
  iface: string;
  address: string;
  isDefaultRoute: boolean;
};

const PRIVATE_RANGES = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

function isPrivateIPv4(addr: string): boolean {
  return PRIVATE_RANGES.some((re) => re.test(addr));
}

export async function listCandidates(): Promise<LanCandidate[]> {
  const defaultIface = await defaultRouteInterface().catch(() => null);

  const all: LanCandidate[] = [];
  for (const [iface, addrs] of Object.entries(networkInterfaces())) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.family !== "IPv4" || a.internal || !isPrivateIPv4(a.address)) continue;
      all.push({
        iface,
        address: a.address,
        isDefaultRoute: defaultIface != null && iface === defaultIface,
      });
    }
  }

  all.sort((a, b) => {
    if (a.isDefaultRoute && !b.isDefaultRoute) return -1;
    if (!a.isDefaultRoute && b.isDefaultRoute) return 1;
    return 0;
  });

  return all;
}

export async function pickCandidate(preferredIface: string | null): Promise<LanCandidate | null> {
  const candidates = await listCandidates();
  if (preferredIface) {
    const match = candidates.find((c) => c.iface === preferredIface);
    if (match) return match;
  }
  return candidates[0] ?? null;
}

async function defaultRouteInterface(): Promise<string | null> {
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("/sbin/route", ["-n", "get", "default"]);
      return stdout.match(/interface:\s*(\S+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const ps =
        `Get-NetRoute -DestinationPrefix '0.0.0.0/0' -AddressFamily IPv4 ` +
        `| Sort-Object RouteMetric, ifMetric | Select-Object -First 1 -ExpandProperty InterfaceAlias`;
      const { stdout } = await execFileAsync("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        ps,
      ]);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }
  if (process.platform === "linux") {
    try {
      const { stdout } = await execFileAsync("ip", ["route", "show", "default"]);
      return stdout.match(/dev\s+(\S+)/)?.[1] ?? null;
    } catch {
      return null;
    }
  }
  return null;
}
