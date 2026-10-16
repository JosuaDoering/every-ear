// Every Ear launcher. A headless background service: it starts the Fastify
// backend, LiveKit and Caddy, then opens the web admin in the default browser.
// There is no tray icon and no settings window — every setting lives in the web
// interface, which is always reachable at http://127.0.0.1:<port>/admin.html.

import { Notification, app, shell } from "electron";
import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { bootstrap } from "./bootstrap";
import { loadSettings, updateSettings } from "./config-store";
import { pickCandidate, type LanCandidate } from "./network";
import { dataDir } from "./paths";
import * as supervisor from "./supervisor";
import * as updater from "./updater";

const BACKEND_PORT = Number(process.env.BACKEND_PORT ?? 3000);
const LISTENER_PORT = Number(process.env.EVERY_EAR_LISTENER_PORT ?? 8443);

// When no LAN interface is available (offline / testing) the stack still starts
// so the web admin is reachable on the loopback address. As soon as an
// interface connects, the watcher restarts the stack with its real IP.
const FALLBACK_HOST = "127.0.0.1";

if (process.platform === "darwin") {
  app.dock?.hide();
}

let currentCandidate: LanCandidate | null = null;
let ipWatcher: NodeJS.Timeout | null = null;
let restartWatcher: NodeJS.Timeout | null = null;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on("second-instance", () => {
  openAdmin();
});

app.on("window-all-closed", () => {
  // Background service — never quit when a window closes (there is no window).
});

app.on("before-quit", () => {});

app.on("will-quit", async (e) => {
  if (supervisor.status() !== "stopped") {
    e.preventDefault();
    await supervisor.stop().catch(() => {});
    if (ipWatcher) clearInterval(ipWatcher);
    if (restartWatcher) clearInterval(restartWatcher);
    updater.disposeUpdater();
    app.exit(0);
  }
});

app.whenReady().then(async () => {
  const { isFirstRun, config } = bootstrap();
  await detectAndStart();
  updater.initUpdater({ onState: () => {} });
  startWatchers();
  openAdmin();

  if (isFirstRun) {
    showNotification(
      `Admin password: ${config.adminPassword} — it is also in ${path.join(dataDir(), "settings.json")}.`,
    );
  }
});

// ---- core flows ------------------------------------------------------------

async function detectAndStart(): Promise<void> {
  const settings = loadSettings();
  const next = await pickCandidate(settings.preferredInterface);
  currentCandidate = next;

  // No LAN interface → fall back to loopback so the web admin still comes up.
  const host = next?.address ?? FALLBACK_HOST;
  if (settings.publicHost !== host) {
    updateSettings({ publicHost: host });
  }

  const env = { publicHost: host, listenerPort: settings.listenerPort, dataDir: dataDir() };
  if (supervisor.status() === "running") {
    await supervisor.restart(env);
  } else if (supervisor.status() === "stopped") {
    await supervisor.start(env);
  }
}

async function restartStack(): Promise<void> {
  const settings = loadSettings();
  const next = currentCandidate ?? (await pickCandidate(settings.preferredInterface));
  const host = next?.address ?? FALLBACK_HOST;
  await supervisor.restart({
    publicHost: host,
    listenerPort: settings.listenerPort,
    dataDir: dataDir(),
  });
}

function startWatchers(): void {
  // Re-evaluate the IP every 5s. A change restarts the stack with the new
  // public host and the QR/listener URL changes.
  ipWatcher = setInterval(async () => {
    const settings = loadSettings();
    const next = await pickCandidate(settings.preferredInterface);
    if (!next) {
      // Lost the network: keep the stack up on loopback (admin stays reachable).
      if (currentCandidate) {
        currentCandidate = null;
        updateSettings({ publicHost: FALLBACK_HOST });
        await restartStack();
        showNotification(
          "No network — listeners are offline, but the web admin stays available on this machine.",
        );
      }
      return;
    }
    if (
      !currentCandidate ||
      currentCandidate.iface !== next.iface ||
      currentCandidate.address !== next.address
    ) {
      currentCandidate = next;
      updateSettings({ publicHost: next.address });
      await restartStack();
      showNotification(`Network changed — listeners now connect to https://${next.address}:${LISTENER_PORT}/`);
    }
  }, 5000);

  // The web admin writes a `.restart-requested` marker for changes that need a
  // process restart (LiveKit credentials, listener port). Act on it here.
  restartWatcher = setInterval(async () => {
    const flag = path.join(dataDir(), ".restart-requested");
    if (existsSync(flag)) {
      rmSync(flag, { force: true });
      await restartStack();
    }
  }, 2000);
}

function openAdmin(): void {
  void shell.openExternal(`http://127.0.0.1:${BACKEND_PORT}/admin.html`);
}

function showNotification(body: string): void {
  if (!Notification.isSupported()) return;
  new Notification({ title: "Every Ear", body }).show();
}

supervisor.events.on(
  "crash",
  ({ name, fatal, detail }: { name: string; fatal?: boolean; detail?: string }) => {
    const suffix = detail ? ` — ${detail}` : "";
    showNotification(`${name} ${fatal ? "crashed fatally" : "restarted"}${suffix}.`);
  },
);

process.on("uncaughtException", (err) => {
  console.error("[main] uncaught", err);
});
