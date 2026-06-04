// System tray (Windows) / menu bar (macOS) icon. Owns the small menu the
// operator interacts with when the settings window is closed.

import { Menu, Tray, app, clipboard, nativeImage, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { isPackaged } from "./paths";

type TrayContext = {
  listenerUrl: () => string | null;
  adminUrl: () => string | null;
  openSettings: () => void;
  copyAdminPassword: () => Promise<void>;
  quit: () => void;
};

let trayInstance: Tray | null = null;
let ctx: TrayContext | null = null;

export function createTray(context: TrayContext): Tray {
  ctx = context;
  trayInstance = new Tray(loadTrayIcon());
  trayInstance.setToolTip("Every Ear");
  rebuildMenu();
  trayInstance.on("click", () => {
    if (process.platform === "win32") context.openSettings();
  });
  return trayInstance;
}

export function refresh(): void {
  if (!trayInstance) return;
  rebuildMenu();
}

export function destroy(): void {
  trayInstance?.destroy();
  trayInstance = null;
  ctx = null;
}

function rebuildMenu(): void {
  if (!trayInstance || !ctx) return;
  const listenerUrl = ctx.listenerUrl();
  const adminUrl = ctx.adminUrl();

  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: listenerUrl
        ? `Listener: ${listenerUrl}`
        : "Listener URL — not ready yet",
      enabled: Boolean(listenerUrl),
      click: () => {
        if (listenerUrl) void shell.openExternal(listenerUrl);
      },
    },
    {
      label: "Copy listener URL",
      enabled: Boolean(listenerUrl),
      click: () => {
        if (listenerUrl) clipboard.writeText(listenerUrl);
      },
    },
    { type: "separator" },
    {
      label: "Open admin page",
      enabled: Boolean(adminUrl),
      click: () => {
        if (adminUrl) void shell.openExternal(adminUrl);
      },
    },
    {
      label: "Copy admin password",
      click: () => {
        void ctx!.copyAdminPassword();
      },
    },
    { type: "separator" },
    {
      label: "Settings…",
      click: () => ctx!.openSettings(),
    },
    { type: "separator" },
    {
      label: `Every Ear ${app.getVersion()}`,
      enabled: false,
    },
    {
      label: "Quit",
      click: () => ctx!.quit(),
    },
  ];

  trayInstance.setContextMenu(Menu.buildFromTemplate(items));
}

function trayIconPath(): string {
  // In packaged mode, electron-builder places extraResources directly under
  // Contents/Resources/ (mac) or resources\ (win). In dev mode, the file
  // sits next to the source tree under desktop/resources/.
  // We use a separate `tray-icon.png` (22×22 monochrome template) instead of
  // the 512×512 brand `icon.png` electron-builder uses for the .app bundle.
  if (isPackaged) {
    return path.join(process.resourcesPath, "tray-icon.png");
  }
  return path.join(__dirname, "..", "resources", "tray-icon.png");
}

function loadTrayIcon(): Electron.NativeImage {
  const iconPath = trayIconPath();

  if (!existsSync(iconPath)) {
    // Last-resort: an empty image. Tray() requires a non-null NativeImage,
    // so we surface a clearly-broken square (16x16 black) rather than crash.
    // Should never happen in practice — generate-icon.mjs commits the file.
    console.error(`[tray] icon not found at ${iconPath}`);
    return nativeImage.createFromBuffer(Buffer.alloc(16 * 16 * 4, 0xff), {
      width: 16,
      height: 16,
    });
  }

  const img = nativeImage.createFromPath(iconPath);

  if (process.platform === "darwin") {
    // Template images are alpha-only; macOS recolours them to match the
    // current menu-bar foreground (light vs dark theme). Our generated PNG
    // is already alpha-only black-on-transparent.
    img.setTemplateImage(true);
  }

  return img;
}
