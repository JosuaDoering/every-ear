// Web-admin settings API (mounted under /api/admin).
//
// Covers everything that used to live in the Electron settings window: admin
// password, listener port / interface, custom TLS domain + certificate (Netcup
// automatic, manual DNS-01, or own PEM), DNS A-record update, LiveKit
// credential regeneration, and a data reset.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes, X509Certificate, createPrivateKey, type KeyObject } from "node:crypto";
import { config } from "./config.js";
import {
  getSettings,
  updateSettings,
  writeLivekitEnv,
  isValidHost,
  type Settings,
} from "./settings.js";
import { reloadCaddy } from "./caddy.js";
import { listCandidates } from "./network.js";
import { isLiveKitReachable, resetStatsData } from "./stats.js";
import { ensureDefaultEvent, resetEventsCache } from "./events.js";
import { listCodes, resetCodesCache } from "./codes.js";
import { listLanguages, resetLanguagesCache } from "./languages.js";
import * as acme from "./acme/manager.js";
import {
  withAcmeLock,
  renewCertificateIfNeeded,
  certDaysRemaining,
  canAutoRenew,
  isAcmeBusy,
} from "./acme/renewal.js";

const RESTART_FLAG = () => path.join(config.dataDir, ".restart-requested");

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reject a PEM pair Caddy would refuse to load. A bad pair is persisted into
 * settings.json, so it would also break every later Caddy start, not just this
 * reload — the failure has to happen before the files are written.
 */
function assertUsableCertificate(certPem: string, keyPem: string): void {
  let cert: X509Certificate;
  let key: KeyObject;
  try {
    cert = new X509Certificate(certPem);
    key = createPrivateKey(keyPem);
  } catch (err) {
    throw new Error(`invalid certificate or key: ${errorMessage(err)}`);
  }
  if (!cert.checkPrivateKey(key)) {
    throw new Error("certificate and private key do not match");
  }
  const now = Date.now();
  if (Date.parse(cert.validTo) < now) {
    throw new Error(`certificate expired on ${cert.validTo}`);
  }
  if (Date.parse(cert.validFrom) > now) {
    throw new Error(`certificate is not valid before ${cert.validFrom}`);
  }
}

async function requestRestart(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.writeFile(RESTART_FLAG(), new Date().toISOString());
}

function withPort(host: string, port: number): string {
  return port === 443 ? host : `${host}:${port}`;
}

function listenerUrl(s: Settings): string {
  const host = s.customDomain?.trim() || s.publicHost?.trim() || "localhost";
  return `https://${withPort(host, s.listenerPort)}/`;
}

function adminUrl(s: Settings): string {
  return `${listenerUrl(s)}admin.html`;
}

/** A minimal SSE writer over a hijacked reply. */
function openSse(reply: FastifyReply): { send: (event: object) => void; end: () => void } {
  reply.hijack();
  const raw = reply.raw;
  let closed = false;
  raw.on("close", () => {
    closed = true;
  });
  // Without a listener a write after the client disconnects can surface as an
  // unhandled 'error' event.
  raw.on("error", () => {
    closed = true;
  });
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return {
    send: (event) => {
      if (closed || raw.destroyed || raw.writableEnded) return;
      try {
        raw.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch {
        closed = true;
      }
    },
    end: () => {
      if (closed || raw.writableEnded) return;
      try {
        raw.end();
      } catch {
        // ignore
      }
    },
  };
}

/** The currently running certificate operation, for explicit cancellation. */
let activeAcmeAbort: AbortController | null = null;

function beginAcmeOperation(reply: FastifyReply): AbortController {
  const ac = new AbortController();
  activeAcmeAbort = ac;
  // If the admin closes the tab / the connection drops, abort the operation so
  // the ACME lock is released and the next attempt can start immediately.
  reply.raw.on("close", () => ac.abort());
  reply.raw.on("error", () => ac.abort());
  return ac;
}

function endAcmeOperation(ac: AbortController): void {
  if (activeAcmeAbort === ac) activeAcmeAbort = null;
}

export const settingsApiPlugin: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/settings", async () => {
    const s = getSettings();
    const candidates = await listCandidates();
    return {
      settings: {
        listenerPort: s.listenerPort,
        publicHost: s.publicHost,
        preferredInterface: s.preferredInterface,
        languages: s.languages,
        customDomain: s.customDomain,
        customCertFile: s.customCertFile,
        customKeyFile: s.customKeyFile,
        hasNetcupKey: Boolean(s.netcupApiKey),
        livekitApiKey: s.livekitApiKey,
      },
      candidates,
      urls: {
        listener: listenerUrl(s),
        admin: adminUrl(s),
        local: `http://127.0.0.1:${config.port}/admin.html`,
      },
      cert: {
        domain: s.customDomain,
        daysRemaining: certDaysRemaining(s.customCertFile),
        autoRenew: canAutoRenew(),
      },
    };
  });

  // Update general settings. Returns whether a stack restart is required.
  app.put<{
    Body: {
      adminPassword?: string;
      listenerPort?: number;
      preferredInterface?: string | null;
      languages?: string;
      customDomain?: string | null;
      netcupApiKey?: string;
    };
  }>("/settings", async (req, reply) => {
    const body = req.body ?? {};
    const patch: Partial<Settings> = {};
    let restart = false;

    if (typeof body.adminPassword === "string" && body.adminPassword.trim()) {
      const pw = body.adminPassword.trim();
      // The password is the only admin credential; a short one is guessable in
      // a few minutes against the 60 req/min admin rate limit. The installer
      // generates 24 hex chars, so this only rejects hand-set weak values.
      if (pw.length < 12) {
        return reply.code(400).send({ error: "adminPassword must be at least 12 characters" });
      }
      patch.adminPassword = pw;
    }
    if (typeof body.listenerPort !== "undefined") {
      const port = body.listenerPort;
      // Reject instead of silently ignoring: the UI would otherwise report
      // "saved" for a port that never took effect.
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
        return reply.code(400).send({ error: "listenerPort must be an integer between 1 and 65535" });
      }
      patch.listenerPort = port;
    }
    if (typeof body.languages === "string") {
      patch.languages = body.languages;
    }
    if (typeof body.customDomain !== "undefined") {
      const domain = body.customDomain?.trim() || null;
      if (domain && !isValidHost(domain)) {
        return reply.code(400).send({ error: "invalid domain" });
      }
      patch.customDomain = domain;
    }
    if (typeof body.netcupApiKey === "string" && body.netcupApiKey && !body.netcupApiKey.startsWith("…")) {
      patch.netcupApiKey = body.netcupApiKey.trim();
    }
    if (typeof body.preferredInterface !== "undefined") {
      patch.preferredInterface = body.preferredInterface || null;
      // A new interface changes publicHost → LiveKit node-ip must restart.
      const picked = (await listCandidates()).find((c) => c.iface === patch.preferredInterface);
      if (picked) patch.publicHost = picked.address;
      restart = true;
    }

    try {
      updateSettings(patch);
    } catch (err) {
      return reply.code(500).send({ error: `could not save settings: ${errorMessage(err)}` });
    }
    // Host/port/cert changes apply live via Caddy.
    const caddyReloaded = await reloadCaddy();
    if (restart) await requestRestart();

    return { ok: true, restartRequired: restart, caddyReloaded };
  });

  // ---- Certificates --------------------------------------------------------

  // Automatic issuance via the netcup REST API (DNS-01). Streams progress.
  app.post<{ Body: { domain?: string; netcupApiKey?: string } }>(
    "/certificate/netcup",
    async (req, reply) => {
      const s = getSettings();
      const domain = (req.body?.domain ?? s.customDomain ?? "").trim();
      const apiKey = req.body?.netcupApiKey?.trim() || s.netcupApiKey || "";
      if (isAcmeBusy()) {
        return reply.code(409).send({ error: "certificate operation already in progress" });
      }
      const { send, end } = openSse(reply);
      if (!domain) return (send({ error: "domain required" }), end());
      if (!isValidHost(domain)) return (send({ error: "invalid domain" }), end());
      if (!apiKey) return (send({ error: "netcup API key required" }), end());
      const ac = beginAcmeOperation(reply);
      try {
        const { certFile, keyFile } = await withAcmeLock(() =>
          acme.obtainCertificateViaNetcup(
            domain,
            apiKey,
            (msg) => send({ progress: msg }),
            ac.signal,
          ),
        );
        updateSettings({
          customDomain: domain,
          customCertFile: certFile,
          customKeyFile: keyFile,
          netcupApiKey: apiKey,
        });
        const caddyReloaded = await reloadCaddy();
        send({ done: true, listenerUrl: listenerUrl(getSettings()), caddyReloaded });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "certificate issuance failed" });
      } finally {
        endAcmeOperation(ac);
        end();
      }
    },
  );

  // Manual DNS-01: works with any provider. Emits the TXT record, then polls.
  app.post<{ Body: { domain?: string } }>("/certificate/manual", async (req, reply) => {
    const s = getSettings();
    const domain = (req.body?.domain ?? s.customDomain ?? "").trim();
    if (isAcmeBusy()) {
      return reply.code(409).send({ error: "certificate operation already in progress" });
    }
    const { send, end } = openSse(reply);
    if (!domain) return (send({ error: "domain required" }), end());
    if (!isValidHost(domain)) return (send({ error: "invalid domain" }), end());
    const ac = beginAcmeOperation(reply);
    try {
      const { certFile, keyFile } = await withAcmeLock(() =>
        acme.obtainCertificateManual(
          domain,
          (msg) => send({ progress: msg }),
          (challenge) => send({ challenge }),
          ac.signal,
        ),
      );
      updateSettings({ customDomain: domain, customCertFile: certFile, customKeyFile: keyFile });
      const caddyReloaded = await reloadCaddy();
      send({ done: true, listenerUrl: listenerUrl(getSettings()), caddyReloaded });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : "certificate issuance failed" });
    } finally {
      endAcmeOperation(ac);
      end();
    }
  });

  // Renew now (also runs automatically). Streams progress over SSE.
  app.post("/certificate/renew", async (_req, reply) => {
    if (isAcmeBusy()) {
      return reply.code(409).send({ error: "certificate operation already in progress" });
    }
    const { send, end } = openSse(reply);
    const ac = beginAcmeOperation(reply);
    try {
      const result = await renewCertificateIfNeeded((msg) => send({ progress: msg }), ac.signal);
      send({ done: true, result, listenerUrl: listenerUrl(getSettings()) });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : "renewal failed" });
    } finally {
      endAcmeOperation(ac);
      end();
    }
  });

  // Abort a running certificate operation (e.g. a stale attempt that would
  // otherwise keep the ACME lock busy).
  app.post("/certificate/cancel", async () => {
    const ac = activeAcmeAbort;
    if (!ac) return { ok: false, message: "no certificate operation running" };
    ac.abort();
    return { ok: true };
  });

  // Upload an own PEM certificate + key.
  app.put<{ Body: { domain?: string; certPem?: string; keyPem?: string } }>(
    "/certificate/own",
    async (req, reply) => {
      const { domain, certPem, keyPem } = req.body ?? {};
      if (!certPem?.includes("BEGIN CERTIFICATE") || !keyPem?.includes("PRIVATE KEY")) {
        return reply.code(400).send({ error: "certPem and keyPem required" });
      }
      const ownDomain = domain?.trim() || null;
      if (ownDomain && !isValidHost(ownDomain)) {
        return reply.code(400).send({ error: "invalid domain" });
      }
      try {
        assertUsableCertificate(certPem, keyPem);
      } catch (err) {
        return reply.code(400).send({ error: errorMessage(err) });
      }
      const certsDir = path.join(config.dataDir, "certs");
      await fs.mkdir(certsDir, { recursive: true });
      const certFile = path.join(certsDir, "cert.pem");
      const keyFile = path.join(certsDir, "key.pem");
      await fs.writeFile(certFile, certPem, { mode: 0o600 });
      await fs.writeFile(keyFile, keyPem, { mode: 0o600 });
      try {
        updateSettings({
          ...(ownDomain ? { customDomain: ownDomain } : {}),
          customCertFile: certFile,
          customKeyFile: keyFile,
        });
      } catch (err) {
        return reply.code(500).send({ error: `could not save settings: ${errorMessage(err)}` });
      }
      const caddyReloaded = await reloadCaddy();
      return { ok: caddyReloaded, caddyReloaded, listenerUrl: listenerUrl(getSettings()) };
    },
  );

  // Revert to Caddy's internal CA.
  app.post("/certificate/reset", async (_req, reply) => {
    try {
      updateSettings({ customDomain: null, customCertFile: null, customKeyFile: null });
    } catch (err) {
      return reply.code(500).send({ error: `could not save settings: ${errorMessage(err)}` });
    }
    const caddyReloaded = await reloadCaddy();
    return { ok: true, listenerUrl: listenerUrl(getSettings()), caddyReloaded };
  });

  // ---- Credentials + reset -------------------------------------------------

  app.post("/credentials/regenerate", async (_req, reply) => {
    const nextKey = `lk_${randomBytes(8).toString("hex")}`;
    const nextSecret = randomBytes(32).toString("base64url");
    try {
      updateSettings({ livekitApiKey: nextKey, livekitApiSecret: nextSecret });
    } catch (err) {
      return reply.code(500).send({ error: `could not save settings: ${errorMessage(err)}` });
    }
    writeLivekitEnv();
    await requestRestart();
    return { ok: true, livekitApiKey: nextKey, restartRequired: true };
  });

  // Wipe event data (events, codes, languages, stats, backgrounds). Keeps
  // credentials and settings — ai-config.json holds the OpenRouter key and model,
  // which are credentials, and the admin UI never offered to delete them.
  // In-memory caches are reset and the defaults are re-seeded, so no process
  // restart is needed.
  app.post("/reset", async () => {
    const files = ["events.json", "codes.json", "languages.json", "stats.json"];
    for (const f of files) {
      await fs.rm(path.join(config.dataDir, f), { force: true });
    }
    const entries = await fs.readdir(config.dataDir).catch(() => [] as string[]);
    for (const f of entries) {
      if (f.startsWith("event-") || f.startsWith("background.")) {
        await fs.rm(path.join(config.dataDir, f), { force: true });
      }
    }

    resetEventsCache();
    resetCodesCache();
    resetLanguagesCache();
    resetStatsData();

    // Re-seed the defaults so the admin UI stays usable immediately.
    await listLanguages();
    await ensureDefaultEvent();
    await listCodes();

    return { ok: true, restartRequired: false };
  });

  app.get("/status", async () => {
    const flag = await fs
      .access(RESTART_FLAG())
      .then(() => true)
      .catch(() => false);
    return {
      restartRequired: flag,
      livekit: isLiveKitReachable() ? "ok" : "unreachable",
      uptimeMs: process.uptime() * 1000,
    };
  });
};
