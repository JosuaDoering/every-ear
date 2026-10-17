// Automatic renewal of certificates issued through the Netcup DNS-01 flow.
//
// Runs at boot and periodically thereafter. Only certificates obtained
// automatically (custom domain + Netcup credentials) can be renewed here — a
// manually-issued or uploaded certificate has to be replaced by the admin.
//
// A shared lock serialises ACME work so this job and a web-admin issuance can
// never run at the same time.

import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { getSettings, updateSettings } from "../settings.js";
import { reloadCaddy } from "../caddy.js";
import { obtainCertificateViaNetcup } from "./manager.js";

const RENEW_BEFORE_DAYS = Math.max(1, Number(process.env.ACME_RENEW_BEFORE_DAYS ?? 30) || 30);
const CHECK_MS = Math.max(60_000, Number(process.env.ACME_RENEW_CHECK_MS ?? 12 * 60 * 60 * 1000) || 0);
// Safety net: a manual DNS-01 run may legitimately take ~10 minutes (30 × 20 s),
// and netcup propagation up to ~15 minutes. Anything beyond this is a hang.
const TASK_TIMEOUT_MS = Math.max(
  60_000,
  Number(process.env.ACME_TASK_TIMEOUT_MS ?? 20 * 60 * 1000) || 0,
);

// ---- ACME lock -------------------------------------------------------------

/** Thrown when a certificate operation is already running. */
export class AcmeBusyError extends Error {
  constructor() {
    super("certificate operation already in progress");
    this.name = "AcmeBusyError";
  }
}

let busy = false;

/** True while any ACME issuance/renewal is running. */
export function isAcmeBusy(): boolean {
  return busy;
}

function withTaskTimeout<T>(task: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`certificate operation timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    timer.unref?.();
    task.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Run `task` exclusively. Unlike a promise chain, a second caller does NOT
 * queue behind a possibly-hung operation — it fails fast with AcmeBusyError, so
 * the web UI can show "already in progress" instead of hanging on "Starting…".
 */
export async function withAcmeLock<T>(task: () => Promise<T>): Promise<T> {
  if (busy) throw new AcmeBusyError();
  busy = true;
  try {
    return await withTaskTimeout(task(), TASK_TIMEOUT_MS);
  } finally {
    busy = false;
  }
}

// ---- helpers ---------------------------------------------------------------

/** Days until the certificate at `certFile` expires, or null if unreadable. */
export function certDaysRemaining(certFile: string | null): number | null {
  if (!certFile || !existsSync(certFile)) return null;
  try {
    const pem = readFileSync(certFile, "utf8");
    const cert = new X509Certificate(pem);
    const notAfter = Date.parse(cert.validTo);
    if (!Number.isFinite(notAfter)) return null;
    return Math.floor((notAfter - Date.now()) / 86_400_000);
  } catch {
    return null;
  }
}

/** True if the current settings can be auto-renewed (Netcup DNS-01). */
export function canAutoRenew(): boolean {
  const s = getSettings();
  return Boolean(s.customDomain && s.netcupApiKey);
}

export type RenewResult = "renewed" | "skipped" | "failed";

/**
 * Renew the certificate if it is due and auto-renewal is configured. Safe to
 * call at any time; logs and returns rather than throwing.
 */
export async function renewCertificateIfNeeded(
  onProgress: (msg: string) => void = (m) => console.log("[acme]", m),
): Promise<RenewResult> {
  try {
    return await withAcmeLock(async () => {
    const s = getSettings();
    if (!canAutoRenew()) {
      onProgress("auto-renewal not configured (needs a custom domain + netcup REST API key)");
      return "skipped";
    }
    const days = certDaysRemaining(s.customCertFile);
    if (days === null) {
      onProgress("no readable certificate installed — skipping");
      return "skipped";
    }
    if (days > RENEW_BEFORE_DAYS) {
      onProgress(`certificate valid for ${days} more days — no renewal needed`);
      return "skipped";
    }

    onProgress(`renewing ${s.customDomain} (expires in ${days} days)…`);
    try {
      const { certFile, keyFile } = await obtainCertificateViaNetcup(
        s.customDomain!,
        s.netcupApiKey!,
        onProgress,
      );
      updateSettings({ customCertFile: certFile, customKeyFile: keyFile });
      await reloadCaddy();
      onProgress("certificate renewed and Caddy reloaded");
      return "renewed";
    } catch (err) {
      onProgress(`renewal failed: ${err instanceof Error ? err.message : String(err)}`);
      return "failed";
    }
    });
  } catch (err) {
    if (err instanceof AcmeBusyError) {
      onProgress("another certificate operation is in progress — skipping");
      return "skipped";
    }
    onProgress(`renewal failed: ${err instanceof Error ? err.message : String(err)}`);
    return "failed";
  }
}

/** Start the boot check + periodic renewal timer. */
export function startCertRenewal(): void {
  void renewCertificateIfNeeded();
  const timer = setInterval(() => void renewCertificateIfNeeded(), CHECK_MS);
  timer.unref?.();
}
