// Web-admin settings API (mounted under /api/admin).
//
// Covers everything that used to live in the Electron settings window: admin
// password, listener port / interface, custom TLS domain + certificate (Netcup
// automatic, manual DNS-01, or own PEM), DNS A-record update, LiveKit
// credential regeneration, and a data reset.

import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from "fastify";
import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { config } from "./config.js";
import { getSettings, updateSettings, writeLivekitEnv, type Settings } from "./settings.js";
import { reloadCaddy } from "./caddy.js";
import { listCandidates } from "./network.js";
import { isLiveKitReachable } from "./stats.js";
import * as acme from "./acme/manager.js";
import * as netcup from "./acme/netcup.js";
import {
  withAcmeLock,
  renewCertificateIfNeeded,
  certDaysRemaining,
  canAutoRenew,
} from "./acme/renewal.js";

const RESTART_FLAG = () => path.join(config.dataDir, ".restart-requested");

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
  raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  return {
    send: (event) => raw.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => raw.end(),
  };
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
        netcupCustomerId: s.netcupCustomerId,
        hasNetcupKey: Boolean(s.netcupApiKey),
        hasNetcupPassword: Boolean(s.netcupApiPassword),
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
      netcupCustomerId?: string | null;
      netcupApiKey?: string;
      netcupApiPassword?: string;
    };
  }>("/settings", async (req) => {
    const body = req.body ?? {};
    const patch: Partial<Settings> = {};
    let restart = false;

    if (typeof body.adminPassword === "string" && body.adminPassword.trim()) {
      patch.adminPassword = body.adminPassword.trim();
    }
    if (typeof body.listenerPort === "number" && body.listenerPort > 0 && body.listenerPort < 65536) {
      patch.listenerPort = body.listenerPort;
    }
    if (typeof body.languages === "string") {
      patch.languages = body.languages;
    }
    if (typeof body.customDomain !== "undefined") {
      patch.customDomain = body.customDomain?.trim() || null;
    }
    if (typeof body.netcupCustomerId !== "undefined") {
      patch.netcupCustomerId = body.netcupCustomerId?.trim() || null;
    }
    if (typeof body.netcupApiKey === "string" && body.netcupApiKey && !body.netcupApiKey.startsWith("…")) {
      patch.netcupApiKey = body.netcupApiKey.trim();
    }
    if (typeof body.netcupApiPassword === "string" && body.netcupApiPassword && !body.netcupApiPassword.startsWith("…")) {
      patch.netcupApiPassword = body.netcupApiPassword.trim();
    }
    if (typeof body.preferredInterface !== "undefined") {
      patch.preferredInterface = body.preferredInterface || null;
      // A new interface changes publicHost → LiveKit node-ip must restart.
      const picked = (await listCandidates()).find((c) => c.iface === patch.preferredInterface);
      if (picked) patch.publicHost = picked.address;
      restart = true;
    }

    updateSettings(patch);
    // Host/port/cert changes apply live via Caddy.
    await reloadCaddy();
    if (restart) await requestRestart();

    return { ok: true, restartRequired: restart };
  });

  // ---- Certificates --------------------------------------------------------

  // Automatic issuance via the Netcup DNS API. Streams progress over SSE.
  app.post<{ Body: { domain?: string; netcupCustomerId?: string; netcupApiKey?: string; netcupApiPassword?: string } }>(
    "/certificate/netcup",
    async (req, reply) => {
      const s = getSettings();
      const domain = (req.body?.domain ?? s.customDomain ?? "").trim();
      const creds = {
        customerId: req.body?.netcupCustomerId?.trim() || s.netcupCustomerId || "",
        apiKey: req.body?.netcupApiKey?.trim() || s.netcupApiKey || "",
        apiPassword: req.body?.netcupApiPassword?.trim() || s.netcupApiPassword || "",
      };
      const { send, end } = openSse(reply);
      if (!domain) return (send({ error: "domain required" }), end());
      if (!creds.customerId || !creds.apiKey || !creds.apiPassword) {
        return (send({ error: "Netcup credentials required" }), end());
      }
      try {
        const { certFile, keyFile } = await withAcmeLock(() =>
          acme.obtainCertificateViaNetcup(domain, creds, (msg) => send({ progress: msg })),
        );
        updateSettings({
          customDomain: domain,
          customCertFile: certFile,
          customKeyFile: keyFile,
          netcupCustomerId: creds.customerId,
          netcupApiKey: creds.apiKey,
          netcupApiPassword: creds.apiPassword,
        });
        await reloadCaddy();
        send({ done: true, listenerUrl: listenerUrl(getSettings()) });
      } catch (err) {
        send({ error: err instanceof Error ? err.message : "certificate issuance failed" });
      } finally {
        end();
      }
    },
  );

  // Manual DNS-01: works with any provider. Emits the TXT record, then polls.
  app.post<{ Body: { domain?: string } }>("/certificate/manual", async (req, reply) => {
    const s = getSettings();
    const domain = (req.body?.domain ?? s.customDomain ?? "").trim();
    const { send, end } = openSse(reply);
    if (!domain) return (send({ error: "domain required" }), end());
    try {
      const { certFile, keyFile } = await withAcmeLock(() =>
        acme.obtainCertificateManual(
          domain,
          (msg) => send({ progress: msg }),
          (challenge) => send({ challenge }),
        ),
      );
      updateSettings({ customDomain: domain, customCertFile: certFile, customKeyFile: keyFile });
      await reloadCaddy();
      send({ done: true, listenerUrl: listenerUrl(getSettings()) });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : "certificate issuance failed" });
    } finally {
      end();
    }
  });

  // Renew now (also runs automatically). Streams progress over SSE.
  app.post("/certificate/renew", async (_req, reply) => {
    const { send, end } = openSse(reply);
    try {
      const result = await renewCertificateIfNeeded((msg) => send({ progress: msg }));
      send({ done: true, result, listenerUrl: listenerUrl(getSettings()) });
    } catch (err) {
      send({ error: err instanceof Error ? err.message : "renewal failed" });
    } finally {
      end();
    }
  });

  // Upload an own PEM certificate + key.
  app.put<{ Body: { domain?: string; certPem?: string; keyPem?: string } }>(
    "/certificate/own",
    async (req, reply) => {
      const { domain, certPem, keyPem } = req.body ?? {};
      if (!certPem?.includes("BEGIN CERTIFICATE") || !keyPem?.includes("PRIVATE KEY")) {
        return reply.code(400).send({ error: "certPem and keyPem required" });
      }
      const certsDir = path.join(config.dataDir, "certs");
      await fs.mkdir(certsDir, { recursive: true });
      const certFile = path.join(certsDir, "cert.pem");
      const keyFile = path.join(certsDir, "key.pem");
      await fs.writeFile(certFile, certPem, { mode: 0o600 });
      await fs.writeFile(keyFile, keyPem, { mode: 0o600 });
      updateSettings({
        ...(domain?.trim() ? { customDomain: domain.trim() } : {}),
        customCertFile: certFile,
        customKeyFile: keyFile,
      });
      const ok = await reloadCaddy();
      return { ok, listenerUrl: listenerUrl(getSettings()) };
    },
  );

  // Revert to Caddy's internal CA.
  app.post("/certificate/reset", async () => {
    updateSettings({ customDomain: null, customCertFile: null, customKeyFile: null });
    await reloadCaddy();
    return { ok: true, listenerUrl: listenerUrl(getSettings()) };
  });

  // Point the domain's A record at this host (Netcup).
  app.post<{ Body: { domain?: string; ip?: string } }>("/dns/update-a", async (req, reply) => {
    const s = getSettings();
    const domain = (req.body?.domain ?? s.customDomain ?? "").trim();
    const ip = (req.body?.ip ?? s.publicHost ?? "").trim();
    if (!domain) return reply.code(400).send({ error: "domain required" });
    if (!ip) return reply.code(400).send({ error: "no public host known" });
    if (!s.netcupCustomerId || !s.netcupApiKey || !s.netcupApiPassword) {
      return reply.code(400).send({ error: "Netcup credentials not configured" });
    }
    const result = await netcup.ensureARecord(domain, ip, {
      customerId: s.netcupCustomerId,
      apiKey: s.netcupApiKey,
      apiPassword: s.netcupApiPassword,
    });
    return {
      changed: result.changed,
      previousIp: result.previousIp,
      message: result.changed
        ? `A record updated: ${domain} → ${ip}${result.previousIp ? ` (was ${result.previousIp})` : ""}.`
        : `A record already up to date (${domain} → ${ip}).`,
    };
  });

  // ---- Credentials + reset -------------------------------------------------

  app.post("/credentials/regenerate", async () => {
    const nextKey = `lk_${randomBytes(8).toString("hex")}`;
    const nextSecret = randomBytes(32).toString("base64url");
    updateSettings({ livekitApiKey: nextKey, livekitApiSecret: nextSecret });
    writeLivekitEnv();
    await requestRestart();
    return { ok: true, livekitApiKey: nextKey, restartRequired: true };
  });

  // Wipe event data (events, codes, stats, AI config, backgrounds). Keeps
  // credentials and settings. Requires a restart so in-memory caches reset.
  app.post("/reset", async () => {
    const files = ["events.json", "codes.json", "languages.json", "stats.json", "ai-config.json"];
    for (const f of files) {
      await fs.rm(path.join(config.dataDir, f), { force: true });
    }
    const entries = await fs.readdir(config.dataDir).catch(() => [] as string[]);
    for (const f of entries) {
      if (f.startsWith("event-") || f.startsWith("background.")) {
        await fs.rm(path.join(config.dataDir, f), { force: true });
      }
    }
    await requestRestart();
    return { ok: true, restartRequired: true };
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
