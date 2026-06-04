// The single-window settings UI. Keeps a lazy reference to the BrowserWindow
// so re-opening from the tray reuses the same instance.

import { BrowserWindow, ipcMain, shell, clipboard, dialog } from "electron";
import type { StatusView } from "./preload";
import { isPackaged } from "./paths";

let window: BrowserWindow | null = null;

export function createOrShow(opts: {
  preloadPath: string;
  rendererHtml: string;
  iconPath: string;
}): BrowserWindow {
  if (window && !window.isDestroyed()) {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return window;
  }

  window = new BrowserWindow({
    width: 720,
    height: 660,
    minWidth: 560,
    minHeight: 520,
    title: "Every Ear — Settings",
    show: false,
    icon: opts.iconPath,
    backgroundColor: "#f7f8fa",
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Open devtools off by default; can be enabled with --inspect.
      devTools: !isPackaged,
    },
  });

  // Strip the menu bar — settings has nothing menu-worthy.
  window.removeMenu();

  window.once("ready-to-show", () => {
    window?.show();
  });

  window.on("close", (e) => {
    // Closing the window keeps the supervisor running. Quit lives in tray.
    if (window) {
      e.preventDefault();
      window.hide();
    }
  });

  window.on("closed", () => {
    window = null;
  });

  void window.loadFile(opts.rendererHtml);

  return window;
}

export function broadcastStatus(status: StatusView): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send("settings:status-changed", status);
  }
}

export function broadcastAcmeProgress(msg: string): void {
  if (window && !window.isDestroyed()) {
    window.webContents.send("settings:acme-progress", msg);
  }
}

export function close(): void {
  if (window && !window.isDestroyed()) {
    window.removeAllListeners("close");
    window.close();
  }
  window = null;
}

export type CaddyTlsOpts = {
  domain: string | null;
  certFile: string | null;
  keyFile: string | null;
};

export type SettingsHandlers = {
  getStatus: () => Promise<StatusView>;
  setAdminPassword: (pw: string) => Promise<StatusView>;
  setInterface: (iface: string | null) => Promise<StatusView>;
  setCaddyTls: (opts: CaddyTlsOpts) => Promise<StatusView>;
  obtainCertificate: (opts: {
    domain: string;
    netcupCustomerId: string;
    netcupApiKey: string;
    netcupApiPassword: string;
  }) => Promise<StatusView>;
  updateDnsRecord: (opts: {
    domain: string;
    netcupCustomerId: string;
    netcupApiKey: string;
    netcupApiPassword: string;
  }) => Promise<{ changed: boolean; message: string }>;
  regenerateCredentials: () => Promise<StatusView>;
  resetAllData: () => Promise<StatusView>;
  acknowledgeFirstRun: () => Promise<void>;
  refreshFirewallCheck: () => Promise<StatusView>;
  openFirewallSettings: () => Promise<void>;
};

export function registerIpc(handlers: SettingsHandlers, paths: { logDir: string }): void {
  ipcMain.handle("settings:getStatus", () => handlers.getStatus());
  ipcMain.handle("settings:setAdminPassword", async (_e, pw: string) => {
    if (typeof pw !== "string" || pw.length < 1) {
      throw new Error("Password must be at least 1 character");
    }
    return handlers.setAdminPassword(pw);
  });
  ipcMain.handle("settings:setInterface", (_e, iface: string | null) =>
    handlers.setInterface(iface),
  );
  ipcMain.handle("settings:setCaddyTls", (_e, opts: CaddyTlsOpts) =>
    handlers.setCaddyTls(opts),
  );
  ipcMain.handle(
    "settings:obtainCertificate",
    (
      _e,
      opts: {
        domain: string;
        netcupCustomerId: string;
        netcupApiKey: string;
        netcupApiPassword: string;
      },
    ) => handlers.obtainCertificate(opts),
  );
  ipcMain.handle(
    "settings:updateDnsRecord",
    (
      _e,
      opts: {
        domain: string;
        netcupCustomerId: string;
        netcupApiKey: string;
        netcupApiPassword: string;
      },
    ) => handlers.updateDnsRecord(opts),
  );
  ipcMain.handle(
    "settings:pickFile",
    async (
      _e,
      opts: { title: string; filters: { name: string; extensions: string[] }[] },
    ) => {
      const result = await dialog.showOpenDialog({
        title: opts.title,
        filters: opts.filters,
        properties: ["openFile"],
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  );
  ipcMain.handle("settings:regenerateCredentials", () => handlers.regenerateCredentials());
  ipcMain.handle("settings:resetAllData", () => handlers.resetAllData());
  ipcMain.handle("settings:acknowledgeFirstRun", () => handlers.acknowledgeFirstRun());
  ipcMain.handle("settings:copyToClipboard", (_e, text: string) => {
    clipboard.writeText(typeof text === "string" ? text : "");
  });
  ipcMain.handle("settings:revealLogs", () => {
    void shell.openPath(paths.logDir);
  });
  ipcMain.handle("settings:refreshFirewallCheck", () => handlers.refreshFirewallCheck());
  ipcMain.handle("settings:openFirewallSettings", () => handlers.openFirewallSettings());
}

export function unregisterIpc(): void {
  for (const channel of [
    "settings:getStatus",
    "settings:setAdminPassword",
    "settings:setInterface",
    "settings:setCaddyTls",
    "settings:obtainCertificate",
    "settings:updateDnsRecord",
    "settings:pickFile",
    "settings:regenerateCredentials",
    "settings:resetAllData",
    "settings:acknowledgeFirstRun",
    "settings:copyToClipboard",
    "settings:revealLogs",
    "settings:refreshFirewallCheck",
    "settings:openFirewallSettings",
  ]) {
    ipcMain.removeHandler(channel);
  }
}

