// Entry point: app lifecycle, single-instance lock, supervisor wiring,
// tray + settings window, IP-change watcher.

import { Notification, app, clipboard, dialog, shell } from "electron";
import { rmSync } from "node:fs";
import path from "node:path";
import { bootstrap, regenerateLiveKitCredentials } from "./bootstrap";
import { load as loadConfig, save as saveConfig, update as updateConfig } from "./config-store";
import { listCandidates, pickCandidate, type LanCandidate } from "./network";
import {
  configFile as configFilePath,
  dataDir,
  isPackaged,
  logDir,
  preloadPath,
  rendererHtmlPath,
  userDataDir,
} from "./paths";
import * as acmeManager from "./acme-manager";
import * as firewallCheck from "./firewall-check";
import * as netcupDns from "./netcup-dns";
import * as supervisor from "./supervisor";
import * as settingsWindow from "./settings-window";
import type { StatusView } from "./preload";
import * as tray from "./tray";
import * as updater from "./updater";

// Hide Every Ear from the macOS dock — we're a tray-only app. Has to
// happen before app is ready.
if (process.platform === "darwin") {
  app.dock?.hide();
}

// Caddy binds this port for the listener-facing HTTPS server. 8443 by
// default so a normal user can bind it without sudo / UAC / port-ACL setup.
const LISTENER_PORT = Number(process.env.EVERY_EAR_LISTENER_PORT ?? 8443);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

let currentCandidate: LanCandidate | null = null;
let firstRunPending = false;
let watcherTimer: NodeJS.Timeout | null = null;
let appQuitting = false;

app.on("second-instance", () => {
  showSettings();
});

app.whenReady().then(async () => {
  const { isFirstRun } = bootstrap();
  firstRunPending = isFirstRun;

  await detectAndStart();
  void firewallCheck.refresh().then(() => broadcastStatus());
  startWatcher();

  tray.createTray({
    listenerUrl: () => listenerUrl(),
    adminUrl: () => adminUrl(),
    openSettings: () => showSettings(),
    copyAdminPassword: async () => {
      const cfg = loadConfig();
      if (cfg) {
        clipboard.writeText(cfg.adminPassword);
        showNotification("Admin password copied to clipboard.");
      }
    },
    quit: () => {
      void quitApp();
    },
    updateState: () => updater.getState(),
    checkForUpdates: () => void updater.checkForUpdates(),
    downloadUpdate: () => void updater.downloadUpdate(),
    installUpdate: () => void updater.installUpdate(),
  });

  settingsWindow.registerIpc(
    {
      getStatus: async () => buildStatus(),
      setAdminPassword: async (pw) => {
        updateConfig({ adminPassword: pw });
        await restartStack();
        return buildStatus();
      },
      setInterface: async (iface) => {
        updateConfig({ preferredInterface: iface ?? null });
        await detectAndStart();
        broadcastStatus();
        tray.refresh();
        return buildStatus();
      },
      setCaddyTls: async ({ domain, certFile, keyFile }) => {
        updateConfig({
          customDomain: domain || null,
          customCertFile: certFile || null,
          customKeyFile: keyFile || null,
        });
        await restartStack();
        broadcastStatus();
        tray.refresh();
        return buildStatus();
      },
      obtainCertificate: async (opts) => {
        const creds = {
          customerId: opts.netcupCustomerId,
          apiKey: opts.netcupApiKey,
          apiPassword: opts.netcupApiPassword,
        };
        const { certFile, keyFile } = await acmeManager.obtainCertificateViaNetcup(
          opts.domain,
          creds,
          (msg) => settingsWindow.broadcastAcmeProgress(msg),
        );
        updateConfig({
          customDomain: opts.domain || null,
          customCertFile: certFile,
          customKeyFile: keyFile,
          netcupCustomerId: opts.netcupCustomerId,
          netcupApiKey: opts.netcupApiKey,
          netcupApiPassword: opts.netcupApiPassword,
        });
        if (currentCandidate) {
          settingsWindow.broadcastAcmeProgress(
            `Setting A record ${opts.domain} → ${currentCandidate.address}…`,
          );
          try {
            const result = await netcupDns.ensureARecord(
              opts.domain,
              currentCandidate.address,
              creds,
            );
            settingsWindow.broadcastAcmeProgress(
              result.changed
                ? `A record updated${result.previousIp ? ` (was ${result.previousIp})` : ""}.`
                : "A record already up to date.",
            );
          } catch (err) {
            settingsWindow.broadcastAcmeProgress(
              `Warning: certificate installed but A record update failed: ${err instanceof Error ? err.message : err}`,
            );
          }
        }
        await restartStack();
        broadcastStatus();
        tray.refresh();
        return buildStatus();
      },
      obtainCertificateManual: async (opts) => {
        // Provider-agnostic issuance: the user creates the TXT record by hand at
        // whatever DNS host they use; we surface it and poll until it appears.
        const { certFile, keyFile } = await acmeManager.obtainCertificateManual(
          opts.domain,
          (msg) => settingsWindow.broadcastAcmeProgress(msg),
          (challenge) => settingsWindow.broadcastAcmeChallenge(challenge),
        );
        updateConfig({
          customDomain: opts.domain || null,
          customCertFile: certFile,
          customKeyFile: keyFile,
        });
        // The A record is the user's responsibility in manual mode — we have no
        // provider API to set it, so leave any stored Netcup creds untouched.
        await restartStack();
        broadcastStatus();
        tray.refresh();
        return buildStatus();
      },
      updateDnsRecord: async (opts) => {
        // Repoint the domain's A record at this machine's current IP without
        // touching the certificate — for when the IP changed but the cert is
        // still valid.
        const domain = opts.domain?.trim();
        if (!domain) throw new Error("Enter a domain first.");
        if (!currentCandidate) {
          throw new Error("No active network interface — can't determine this machine's IP.");
        }
        const creds = {
          customerId: opts.netcupCustomerId?.trim(),
          apiKey: opts.netcupApiKey?.trim(),
          apiPassword: opts.netcupApiPassword?.trim(),
        };
        if (!creds.customerId || !creds.apiKey || !creds.apiPassword) {
          throw new Error("All three Netcup fields are required.");
        }
        const result = await netcupDns.ensureARecord(domain, currentCandidate.address, creds);
        // Persist domain + Netcup creds so the automatic IP watcher keeps the
        // record in sync going forward. Certificate files are left untouched.
        updateConfig({
          customDomain: domain,
          netcupCustomerId: creds.customerId,
          netcupApiKey: creds.apiKey,
          netcupApiPassword: creds.apiPassword,
        });
        broadcastStatus();
        tray.refresh();
        const message = result.changed
          ? `A record updated: ${domain} → ${currentCandidate.address}${
              result.previousIp ? ` (was ${result.previousIp})` : ""
            }.`
          : `A record already up to date (${domain} → ${currentCandidate.address}).`;
        return { changed: result.changed, message };
      },
      regenerateCredentials: async () => {
        regenerateLiveKitCredentials();
        await restartStack();
        return buildStatus();
      },
      resetAllData: async () => {
        await wipeAllData();
        return buildStatus();
      },
      acknowledgeFirstRun: async () => {
        firstRunPending = false;
      },
      refreshFirewallCheck: async () => {
        await firewallCheck.refresh();
        return buildStatus();
      },
      openFirewallSettings: async () => {
        if (process.platform === "darwin") {
          await shell.openExternal(
            "x-apple.systempreferences:com.apple.preference.security?Firewall",
          );
        }
      },
      checkForUpdates: async () => {
        await updater.checkForUpdates();
        return buildStatus();
      },
      downloadUpdate: async () => {
        await updater.downloadUpdate();
        return buildStatus();
      },
      installUpdate: async () => {
        updater.installUpdate();
        return buildStatus();
      },
    },
    { logDir: logDir() },
  );

  // Background update channel: Windows auto-updates, macOS detects + notifies.
  // Any state change refreshes both the settings window and the tray label.
  updater.initUpdater({
    onState: () => {
      broadcastStatus();
      tray.refresh();
    },
  });

  if (isFirstRun) {
    showSettings();
  }
});

app.on("window-all-closed", () => {
  // Tray-only — never quit when the settings window closes.
  // Electron auto-quits on window-all-closed except when no handler is
  // attached on macOS. Attaching this empty handler is enough on every OS
  // because we keep the supervisor running anyway and the user quits via
  // the tray.
});

app.on("before-quit", () => {
  appQuitting = true;
});

app.on("will-quit", async (e) => {
  if (supervisor.status() !== "stopped") {
    e.preventDefault();
    await supervisor.stop().catch(() => {});
    if (watcherTimer) clearInterval(watcherTimer);
    updater.disposeUpdater();
    settingsWindow.unregisterIpc();
    tray.destroy();
    app.exit(0);
  }
});

// ---- core flows ------------------------------------------------------------

async function detectAndStart(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg) return;
  currentCandidate = await pickCandidate(cfg.preferredInterface);

  if (!currentCandidate) {
    // No usable LAN — start nothing, but keep the app alive so the user can
    // open settings and see the empty interface picker.
    if (supervisor.status() !== "stopped") await supervisor.stop();
    return;
  }

  const env = {
    livekitApiKey: cfg.livekitApiKey,
    livekitApiSecret: cfg.livekitApiSecret,
    adminPassword: cfg.adminPassword,
    publicHost: currentCandidate.address,
    listenerPort: LISTENER_PORT,
    languages: cfg.languages,
    dataDir: dataDir(),
    customDomain: cfg.customDomain ?? null,
    customCertFile: cfg.customCertFile ?? null,
    customKeyFile: cfg.customKeyFile ?? null,
  };

  if (supervisor.status() === "running") {
    await supervisor.restart(env);
  } else if (supervisor.status() === "stopped") {
    await supervisor.start(env);
  }
}

async function restartStack(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg || !currentCandidate) return;
  await supervisor.restart({
    livekitApiKey: cfg.livekitApiKey,
    livekitApiSecret: cfg.livekitApiSecret,
    adminPassword: cfg.adminPassword,
    publicHost: currentCandidate.address,
    listenerPort: LISTENER_PORT,
    languages: cfg.languages,
    dataDir: dataDir(),
    customDomain: cfg.customDomain ?? null,
    customCertFile: cfg.customCertFile ?? null,
    customKeyFile: cfg.customKeyFile ?? null,
  });
  broadcastStatus();
  tray.refresh();
}

async function wipeAllData(): Promise<void> {
  await supervisor.stop();
  rmSync(dataDir(), { recursive: true, force: true });
  rmSync(configFilePath(), { force: true });
  bootstrap();
  await detectAndStart();
  broadcastStatus();
  tray.refresh();
  showNotification("All event data and credentials reset.");
}

async function quitApp(): Promise<void> {
  appQuitting = true;
  await supervisor.stop().catch(() => {});
  if (watcherTimer) clearInterval(watcherTimer);
  updater.disposeUpdater();
  settingsWindow.unregisterIpc();
  tray.destroy();
  app.exit(0);
}

function startWatcher(): void {
  // Re-evaluate the IP every 5s. When it changes (e.g. user roamed onto a
  // different SSID), restart caddy + livekit with the new PUBLIC_HOST and
  // notify the user — listeners' QR just changed.
  let tick = 0;
  watcherTimer = setInterval(async () => {
    // Re-check the firewall roughly every 30s so a stale warning self-clears
    // after the user toggles the macOS firewall — without reopening settings.
    // Only re-broadcast when the warning actually changed to avoid UI churn.
    if (tick++ % 6 === 0) {
      const before = firewallCheck.getCached().warning;
      const after = (await firewallCheck.refresh()).warning;
      if (before !== after) broadcastStatus();
    }

    const cfg = loadConfig();
    if (!cfg) return;
    const next = await pickCandidate(cfg.preferredInterface);
    if (!next) {
      if (currentCandidate) {
        currentCandidate = null;
        await supervisor.stop().catch(() => {});
        broadcastStatus();
        tray.refresh();
        showNotification("No LAN interface — listeners are offline until network returns.");
      }
      return;
    }
    if (
      !currentCandidate ||
      currentCandidate.iface !== next.iface ||
      currentCandidate.address !== next.address
    ) {
      currentCandidate = next;
      await restartStack();
      // The Netcup A record is intentionally NOT auto-updated here — the user
      // updates it explicitly via the "Update A-record" button in settings.
      showNotification(
        `Network changed — listeners now connect to https://${withPort(next.address)}/`,
      );
    }
  }, 5000);
}

// ---- helpers ---------------------------------------------------------------

function withPort(host: string): string {
  // Hide :443 (in case someone overrides) but always show non-default ports.
  return LISTENER_PORT === 443 ? host : `${host}:${LISTENER_PORT}`;
}

function listenerUrl(): string | null {
  if (!currentCandidate) return null;
  const cfg = loadConfig();
  const host = cfg?.customDomain?.trim() || currentCandidate.address;
  return `https://${withPort(host)}/`;
}

function adminUrl(): string | null {
  if (!currentCandidate) return null;
  const cfg = loadConfig();
  const host = cfg?.customDomain?.trim() || currentCandidate.address;
  return `https://${withPort(host)}/admin.html`;
}

async function buildStatus(): Promise<StatusView> {
  const cfg = loadConfig() ?? bootstrap().config;
  const candidates = (await listCandidates()).map((c) => ({
    iface: c.iface,
    address: c.address,
    isDefaultRoute: c.isDefaultRoute,
  }));
  return {
    listenerUrl: listenerUrl(),
    adminUrl: adminUrl(),
    adminPassword: cfg.adminPassword,
    livekitApiKey: cfg.livekitApiKey,
    candidates,
    currentInterface: currentCandidate?.iface ?? null,
    currentIp: currentCandidate?.address ?? null,
    supervisorStatus: supervisor.status(),
    version: app.getVersion(),
    logDir: logDir(),
    isFirstRun: firstRunPending,
    customDomain: cfg.customDomain ?? null,
    customCertFile: cfg.customCertFile ?? null,
    customKeyFile: cfg.customKeyFile ?? null,
    netcupCustomerId: cfg.netcupCustomerId ?? null,
    netcupApiKey: cfg.netcupApiKey ?? null,
    netcupApiPassword: cfg.netcupApiPassword ?? null,
    firewallWarning: firewallCheck.getCached().warning,
    firewallBinaryPath: firewallCheck.getCached().binaryPath,
    update: updater.getState(),
  };
}

function broadcastStatus(): void {
  void buildStatus().then((s) => settingsWindow.broadcastStatus(s));
}

function showSettings(): void {
  settingsWindow.createOrShow({
    preloadPath: preloadPath(),
    rendererHtml: rendererHtmlPath(),
    iconPath: trayIconForWindow(),
  });
  broadcastStatus();
  // The firewall check is otherwise only run at startup, so toggling the
  // firewall in System Settings afterwards left a stale warning until the user
  // hit "Re-check". Re-evaluate on every open and re-broadcast the result.
  void firewallCheck.refresh().then(() => broadcastStatus());
}

function trayIconForWindow(): string {
  // Mirror the resolution in tray.ts — extraResources lands directly under
  // Contents/Resources/ when packaged, and lives at desktop/resources/ in dev.
  if (isPackaged) {
    return path.join(
      process.resourcesPath,
      process.platform === "win32" ? "icon.ico" : "icon.png",
    );
  }
  return path.join(
    __dirname,
    "..",
    "resources",
    process.platform === "win32" ? "icon.ico" : "icon.png",
  );
}

function showNotification(body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: "Every Ear", body }).show();
}

// Surface unexpected supervisor crashes so the user isn't left wondering why
// listeners stopped working. Don't auto-restart; that hides bugs.
supervisor.events.on("crash", ({ name, code }: { name: string; code: number | null }) => {
  showNotification(`${name} exited unexpectedly (code ${code}). Open Settings to restart.`);
  broadcastStatus();
  tray.refresh();
});

// Last-chance error paths so the user sees something instead of a silent quit.
process.on("uncaughtException", (err) => {
  console.error("[main] uncaught", err);
  if (app.isReady()) {
    void dialog.showMessageBox({ type: "error", message: "Every Ear error", detail: String(err) });
  }
});

// Open external links from the renderer's anchors via the OS browser, never
// in a new BrowserWindow.
app.on("web-contents-created", (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
});
