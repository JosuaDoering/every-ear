// Update channel against GitHub Releases.
//
// Platform strategy:
//   * Windows — full auto-update via electron-updater (NSIS). Downloads in the
//     background and applies on quit or via "Restart & install".
//   * Linux AppImage — electron-updater replaces the AppImage in-place and
//     relaunches. Detected by the APPIMAGE env var set by the AppImage runtime.
//   * macOS — Squirrel.Mac refuses unsigned updates, so we detect via GitHub
//     API and send the user to the DMG download.
//   * Linux deb/rpm — same GitHub API detection, links to the AppImage download.
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
  platform: "win" | "mac" | "linux" | "other";
  /** The running app version. */
  current: string;
  /** Newest version found, or null before the first check. */
  latest: string | null;
  status: UpdateStatus;
  /** 0–100 while a Windows update downloads. */
  downloadPercent?: number;
  /** macOS / Linux deb: URL to open for a manual install (DMG / AppImage). */
  downloadUrl?: string | null;
  error?: string | null;
};

function detectPlatform(): UpdateState["platform"] {
  if (process.platform === "win32") return "win";
  if (process.platform === "darwin") return "mac";
  if (process.platform === "linux") return "linux";
  return "other";
}

// AppImage sets APPIMAGE to its own path; absent means deb/rpm/manual install.
function isAppImage(): boolean {
  return process.platform === "linux" && Boolean(process.env.APPIMAGE);
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
  if (state.platform === "win" || isAppImage()) wireAutoUpdater();

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

// ---- Windows + Linux AppImage (electron-updater) --------------------------

function wireAutoUpdater(): void {
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

// ---- macOS + Linux (deb) — GitHub API detection ---------------------------

type GithubRelease = {
  tag_name?: string;
  html_url?: string;
  assets?: { name: string; browser_download_url: string }[];
};

async function checkGitHub(): Promise<void> {
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
      // macOS: prefer the DMG; Linux (deb install): prefer the AppImage.
      const asset = state.platform === "linux"
        ? data.assets?.find((a) => a.name.toLowerCase().endsWith(".appimage"))
        : data.assets?.find((a) => a.name.toLowerCase().endsWith(".dmg"));
      emit({
        status: "available",
        latest,
        downloadUrl: asset?.browser_download_url ?? data.html_url ?? null,
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
  if (state.platform === "win" || isAppImage()) {
    try {
      await autoUpdater.checkForUpdates();
    } catch (err) {
      emit({ status: "error", error: messageOf(err) });
    }
    return getState();
  }
  if (state.platform === "mac" || state.platform === "linux") {
    await checkGitHub();
    return getState();
  }
  emit({ status: "uptodate" });
  return getState();
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (state.platform === "mac" || (state.platform === "linux" && !isAppImage())) {
    if (state.downloadUrl) await shell.openExternal(state.downloadUrl);
    return getState();
  }
  if (state.platform === "win" || isAppImage()) {
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      emit({ status: "error", error: messageOf(err) });
    }
  }
  return getState();
}

export function installUpdate(): UpdateState {
  if ((state.platform === "win" || isAppImage()) && state.status === "ready") {
    // quitAndInstall spawns the installer / replaces the AppImage then
    // quits — our will-quit handler stops the supervisor first.
    // Defer so the IPC reply is sent first.
    setImmediate(() => autoUpdater.quitAndInstall());
  } else if ((state.platform === "mac" || state.platform === "linux") && state.downloadUrl) {
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
