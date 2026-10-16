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

// ---- serialised ACME lock --------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Run `task` after any other ACME work has finished (never concurrently). */
export function withAcmeLock<T>(task: () => Promise<T>): Promise<T> {
  const next = chain.then(task, task);
  chain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
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
  return Boolean(s.customDomain && s.netcupCustomerId && s.netcupApiKey && s.netcupApiPassword);
}

export type RenewResult = "renewed" | "skipped" | "failed";

/**
 * Renew the certificate if it is due and auto-renewal is configured. Safe to
 * call at any time; logs and returns rather than throwing.
 */
export function renewCertificateIfNeeded(
  onProgress: (msg: string) => void = (m) => console.log("[acme]", m),
): Promise<RenewResult> {
  return withAcmeLock(async () => {
    const s = getSettings();
    if (!canAutoRenew()) {
      onProgress("auto-renewal not configured (needs domain + Netcup credentials)");
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
        {
          customerId: s.netcupCustomerId!,
          apiKey: s.netcupApiKey!,
          apiPassword: s.netcupApiPassword!,
        },
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
}

/** Start the boot check + periodic renewal timer. */
export function startCertRenewal(): void {
  void renewCertificateIfNeeded();
  const timer = setInterval(() => void renewCertificateIfNeeded(), CHECK_MS);
  timer.unref?.();
}
