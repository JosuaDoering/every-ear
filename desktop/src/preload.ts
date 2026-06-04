// Bridge between the sandboxed renderer and the main process. Keep the
// surface minimal; everything goes through ipcRenderer.invoke for typed
// request/reply, plus a small event subscription for live updates.

import { contextBridge, ipcRenderer } from "electron";

export type LanCandidateView = {
  iface: string;
  address: string;
  isDefaultRoute: boolean;
};

export type StatusView = {
  listenerUrl: string | null;
  adminUrl: string | null;
  adminPassword: string;
  livekitApiKey: string;
  candidates: LanCandidateView[];
  currentInterface: string | null;
  supervisorStatus: "stopped" | "starting" | "running" | "stopping";
  version: string;
  logDir: string;
  isFirstRun: boolean;
  customDomain: string | null;
  customCertFile: string | null;
  customKeyFile: string | null;
  netcupCustomerId: string | null;
  netcupApiKey: string | null;
  netcupApiPassword: string | null;
  firewallWarning: string | null;
  firewallBinaryPath: string | null;
};

const api = {
  getStatus: (): Promise<StatusView> => ipcRenderer.invoke("settings:getStatus"),
  setAdminPassword: (pw: string): Promise<StatusView> =>
    ipcRenderer.invoke("settings:setAdminPassword", pw),
  setInterface: (iface: string | null): Promise<StatusView> =>
    ipcRenderer.invoke("settings:setInterface", iface),
  setCaddyTls: (opts: {
    domain: string | null;
    certFile: string | null;
    keyFile: string | null;
  }): Promise<StatusView> => ipcRenderer.invoke("settings:setCaddyTls", opts),
  obtainCertificate: (opts: {
    domain: string;
    netcupCustomerId: string;
    netcupApiKey: string;
    netcupApiPassword: string;
  }): Promise<StatusView> => ipcRenderer.invoke("settings:obtainCertificate", opts),
  updateDnsRecord: (opts: {
    domain: string;
    netcupCustomerId: string;
    netcupApiKey: string;
    netcupApiPassword: string;
  }): Promise<{ changed: boolean; message: string }> =>
    ipcRenderer.invoke("settings:updateDnsRecord", opts),
  onAcmeProgress: (cb: (msg: string) => void): (() => void) => {
    const listener = (_e: unknown, msg: string) => cb(msg);
    ipcRenderer.on("settings:acme-progress", listener);
    return () => ipcRenderer.removeListener("settings:acme-progress", listener);
  },
  pickFile: (opts: {
    title: string;
    filters: { name: string; extensions: string[] }[];
  }): Promise<string | null> => ipcRenderer.invoke("settings:pickFile", opts),
  regenerateCredentials: (): Promise<StatusView> =>
    ipcRenderer.invoke("settings:regenerateCredentials"),
  resetAllData: (): Promise<StatusView> =>
    ipcRenderer.invoke("settings:resetAllData"),
  copyToClipboard: (text: string): Promise<void> =>
    ipcRenderer.invoke("settings:copyToClipboard", text),
  revealLogs: (): Promise<void> => ipcRenderer.invoke("settings:revealLogs"),
  refreshFirewallCheck: (): Promise<StatusView> =>
    ipcRenderer.invoke("settings:refreshFirewallCheck"),
  openFirewallSettings: (): Promise<void> =>
    ipcRenderer.invoke("settings:openFirewallSettings"),
  acknowledgeFirstRun: (): Promise<void> =>
    ipcRenderer.invoke("settings:acknowledgeFirstRun"),
  onStatusChanged: (cb: (status: StatusView) => void): (() => void) => {
    const listener = (_e: unknown, status: StatusView) => cb(status);
    ipcRenderer.on("settings:status-changed", listener);
    return () => ipcRenderer.removeListener("settings:status-changed", listener);
  },
};

contextBridge.exposeInMainWorld("everyEar", api);

export type EveryEarApi = typeof api;
