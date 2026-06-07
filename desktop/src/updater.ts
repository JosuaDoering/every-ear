// Update channel against GitHub Releases.
//
// The two platforms differ because the app is unsigned:
//   * Windows — full auto-update via electron-updater (Squirrel/NSIS). The
//     installer downloads in the background and applies on the next quit, or
//     immediately via "Restart & install". Works fine unsigned.
//   * macOS — Squirrel.Mac refuses to install unsigned updates, so we can't
//     auto-install. Instead we *detect* a newer release through the GitHub API
//     and send the user to the DMG to install by hand.
//
// State is kept here and pushed to the renderer/tray by the `onState` callback,
// which routes through the existing buildStatus()/broadcastStatus() machinery.

import { Notification, app, shell } from "electron";
import { autoUpdater } from "electron-updater";

// Where releases live. Keep in sync with electron-builder.yml's `publish` block.
const REPO_OWNER = "JosuaDoering";
const REPO_NAME = "every-ear";

const STARTUP_DELAY_MS = 10_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6 h

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

export type UpdateState = {
  platform: "win" | "mac" | "other";
  /** The running app version. */
  current: string;
  /** Newest version found, or null before the first check. */
  latest: string | null;
  status: UpdateStatus;
  /** 0–100 while a Windows update downloads. */
  downloadPercent?: number;
  /** macOS only: the DMG (or release page) to open for a manual install. */
  downloadUrl?: string | null;
  error?: string | null;
};

function detectPlatform(): UpdateState["platform"] {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  return "other";
}

let state: UpdateState = {
  platform: detectPlatform(),
  current: app.getVersion(),
  latest: null,
  status: "idle",
  downloadUrl: null,
  error: null,
};

let onState: ((s: UpdateState) => void) | null = null;
let checkTimer: NodeJS.Timeout | null = null;
let windowsWired = false;
// Avoid re-notifying for the same version every poll.
let notifiedVersion: string | null = null;

export function getState(): UpdateState {
  return { ...state };
}

function emit(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch };
  onState?.(getState());
}

export function initUpdater(opts: { onState: (s: UpdateState) => void }): void {
  onState = opts.onState;
  if (state.platform === "win") wireWindows();

  // First check shortly after launch (let the stack settle), then on a slow
  // interval. Timers are unref'd so they never hold the app open.
  setTimeout(() => void checkForUpdates(), STARTUP_DELAY_MS).unref?.();
  checkTimer = setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS);
  checkTimer.unref?.();
}

export function disposeUpdater(): void {
  if (checkTimer) clearInterval(checkTimer);
  checkTimer = null;
}

// ---- Windows (electron-updater) -------------------------------------------

function wireWindows(): void {
  if (windowsWired) return;
  windowsWired = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => emit({ status: "checking", error: null }));
  autoUpdater.on("update-available", (info) =>
    emit({ status: "downloading", latest: info.version, downloadPercent: 0 }),
  );
  autoUpdater.on("update-not-available", (info) =>
    emit({ status: "uptodate", latest: info.version ?? state.current, downloadPercent: undefined }),
  );
  autoUpdater.on("download-progress", (p) =>
    emit({ status: "downloading", downloadPercent: Math.round(p.percent) }),
  );
  autoUpdater.on("update-downloaded", (info) => {
    emit({ status: "ready", latest: info.version, downloadPercent: 100 });
    notifyOnce(info.version, `Update ${info.version} is ready — restart to install.`);
  });
  autoUpdater.on("error", (err) => emit({ status: "error", error: messageOf(err) }));
}

// ---- macOS (GitHub API detection) -----------------------------------------

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: { name: string; browser_download_url: string }[];
};

async function checkMac(): Promise<void> {
  emit({ status: "checking", error: null });
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      { headers: { "User-Agent": "every-ear", Accept: "application/vnd.github+json" } },
    );
    if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
    const data = (await res.json()) as GithubRelease;
    const latest = (data.tag_name ?? "").replace(/^v/, "");
    if (!latest) throw new Error("No release tag found.");

    if (isNewer(latest, state.current)) {
      const dmg = data.assets?.find((a) => a.name.toLowerCase().endsWith(".dmg"));
      emit({
        status: "available",
        latest,
        downloadUrl: dmg?.browser_download_url ?? data.html_url ?? null,
      });
      notifyOnce(latest, `Update ${latest} available — click to download.`);
    } else {
      emit({ status: "uptodate", latest });
    }
  } catch (err) {
    emit({ status: "error", error: messageOf(err) });
  }
}

// ---- Public actions (driven by IPC / tray) --------------------------------

export async function checkForUpdates(): Promise<UpdateState> {
  if (state.platform === "win") {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emit({ status: "error", error: messageOf(err) });
    }
    return getState();
  }
  if (state.platform === "mac") {
    await checkMac();
    return getState();
  }
  emit({ status: "uptodate" });
  return getState();
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.platform === "mac") {
    if (state.downloadUrl) await shell.openExternal(state.downloadUrl);
    return getState();
  }
  if (state.platform === "win") {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      emit({ status: "error", error: messageOf(err) });
    }
  }
  return getState();
}

export function installUpdate(): UpdateState {
  if (state.platform === "win" && state.status === "ready") {
    // quitAndInstall spawns the installer (which waits for us to exit) and then
    // quits — our will-quit handler stops the supervisor before the app dies.
    // Defer so the IPC reply is sent first.
    setImmediate(() => autoUpdater.quitAndInstall());
  } else if (state.platform === "mac" && state.downloadUrl) {
    void shell.openExternal(state.downloadUrl);
  }
  return getState();
}

// ---- helpers --------------------------------------------------------------

function notifyOnce(version: string, body: string): void {
  if (notifiedVersion === version) return;
  notifiedVersion = version;
  if (Notification.isSupported()) new Notification({ title: "Every Ear", body }).show();
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Compare plain `major.minor.patch` versions. Returns true if `a` > `b`. */
function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da > db;
  }
  return false;
}

function parseVersion(v: string): number[] {
  return v
    .replace(/^v/, "")
    .split(".")
    .map((n) => parseInt(n, 10) || 0);
}
