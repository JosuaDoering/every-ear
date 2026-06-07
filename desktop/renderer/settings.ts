// Renderer for the settings window. Talks to main via the contextBridge
// `window.everyEar` API exposed by preload.ts.

type LanCandidateView = {
  iface: string;
  address: string;
  isDefaultRoute: boolean;
};

type StatusView = {
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
  currentIp: string | null;
  customDomain: string | null;
  customCertFile: string | null;
  customKeyFile: string | null;
  netcupCustomerId: string | null;
  netcupApiKey: string | null;
  netcupApiPassword: string | null;
  firewallWarning: string | null;
  firewallBinaryPath: string | null;
};

declare global {
  interface Window {
    everyEar: {
      getStatus: () => Promise<StatusView>;
      setAdminPassword: (pw: string) => Promise<StatusView>;
      setInterface: (iface: string | null) => Promise<StatusView>;
      setCaddyTls: (opts: {
        domain: string | null;
        certFile: string | null;
        keyFile: string | null;
      }) => Promise<StatusView>;
      obtainCertificate: (opts: {
        domain: string;
        netcupCustomerId: string;
        netcupApiKey: string;
        netcupApiPassword: string;
      }) => Promise<StatusView>;
      obtainCertificateManual: (opts: { domain: string }) => Promise<StatusView>;
      onAcmeChallenge: (
        cb: (challenge: { recordType: string; recordName: string; recordValue: string }) => void,
      ) => () => void;
      updateDnsRecord: (opts: {
        domain: string;
        netcupCustomerId: string;
        netcupApiKey: string;
        netcupApiPassword: string;
      }) => Promise<{ changed: boolean; message: string }>;
      onAcmeProgress: (cb: (msg: string) => void) => () => void;
      pickFile: (opts: {
        title: string;
        filters: { name: string; extensions: string[] }[];
      }) => Promise<string | null>;
      regenerateCredentials: () => Promise<StatusView>;
      resetAllData: () => Promise<StatusView>;
      copyToClipboard: (text: string) => Promise<void>;
      revealLogs: () => Promise<void>;
      refreshFirewallCheck: () => Promise<StatusView>;
      openFirewallSettings: () => Promise<void>;
      acknowledgeFirstRun: () => Promise<void>;
      onStatusChanged: (cb: (status: StatusView) => void) => () => void;
    };
  }
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as T;
};

const els = {
  statusPill: $<HTMLSpanElement>("status-pill"),
  listenerUrl: $<HTMLElement>("listener-url"),
  copyUrl: $<HTMLButtonElement>("copy-url"),
  openAdmin: $<HTMLButtonElement>("open-admin"),
  ifaceRow: $<HTMLDivElement>("iface-row"),
  ifaceSelect: $<HTMLSelectElement>("iface-select"),
  noLan: $<HTMLElement>("no-lan"),
  refreshLan: $<HTMLButtonElement>("refresh-lan"),
  password: $<HTMLInputElement>("admin-password"),
  togglePassword: $<HTMLButtonElement>("toggle-password"),
  copyPassword: $<HTMLButtonElement>("copy-password"),
  savePassword: $<HTMLButtonElement>("save-password"),
  saveStatus: $<HTMLSpanElement>("save-status"),
  customDomain: $<HTMLInputElement>("custom-domain"),
  certFile: $<HTMLInputElement>("cert-file"),
  pickCert: $<HTMLButtonElement>("pick-cert"),
  keyFile: $<HTMLInputElement>("key-file"),
  pickKey: $<HTMLButtonElement>("pick-key"),
  netcupCustomerId: $<HTMLInputElement>("netcup-customer-id"),
  netcupApiKey: $<HTMLInputElement>("netcup-api-key"),
  netcupApiPassword: $<HTMLInputElement>("netcup-api-password"),
  obtainCert: $<HTMLButtonElement>("obtain-cert"),
  acmeStatus: $<HTMLSpanElement>("acme-status"),
  updateDns: $<HTMLButtonElement>("update-dns"),
  dnsStatus: $<HTMLSpanElement>("dns-status"),
  dnsProvider: $<HTMLSelectElement>("dns-provider"),
  acmeNetcup: $<HTMLDivElement>("acme-netcup"),
  acmeManual: $<HTMLDivElement>("acme-manual"),
  obtainCertManual: $<HTMLButtonElement>("obtain-cert-manual"),
  acmeManualStatus: $<HTMLSpanElement>("acme-manual-status"),
  manualTxtBox: $<HTMLDivElement>("manual-txt-box"),
  manualAName: $<HTMLElement>("manual-a-name"),
  manualAValue: $<HTMLElement>("manual-a-value"),
  manualTxtName: $<HTMLElement>("manual-txt-name"),
  manualTxtValue: $<HTMLElement>("manual-txt-value"),
  dnsAName: $<HTMLElement>("dns-a-name"),
  dnsAValue: $<HTMLElement>("dns-a-value"),
  saveHttps: $<HTMLButtonElement>("save-https"),
  clearHttps: $<HTMLButtonElement>("clear-https"),
  httpsStatus: $<HTMLSpanElement>("https-status"),
  certTab: $<HTMLButtonElement>("cert-tab"),
  acmeTab: $<HTMLButtonElement>("acme-tab"),
  tabManual: $<HTMLDivElement>("tab-manual"),
  tabAcme: $<HTMLDivElement>("tab-acme"),
  regenCreds: $<HTMLButtonElement>("regen-creds"),
  resetData: $<HTMLButtonElement>("reset-data"),
  revealLogs: $<HTMLButtonElement>("reveal-logs"),
  logPathHint: $<HTMLElement>("log-path-hint"),
  versionHint: $<HTMLElement>("version-hint"),
  firstRunModal: $<HTMLDivElement>("first-run-modal"),
  firstRunPassword: $<HTMLElement>("first-run-password"),
  firstRunCopy: $<HTMLButtonElement>("first-run-copy"),
  firewallBanner: $<HTMLDivElement>("firewall-banner"),
  firewallBannerMsg: $<HTMLElement>("firewall-banner-msg"),
  firewallBannerPath: $<HTMLElement>("firewall-banner-path"),
  firewallOpen: $<HTMLButtonElement>("firewall-open"),
  firewallRecheck: $<HTMLButtonElement>("firewall-recheck"),
  firewallInfo: $<HTMLButtonElement>("firewall-info"),
  firewallInfoModal: $<HTMLDivElement>("firewall-info-modal"),
  firewallInfoPath: $<HTMLElement>("firewall-info-path"),
  firewallInfoClose: $<HTMLButtonElement>("firewall-info-close"),
  firewallInfoDismiss: $<HTMLButtonElement>("firewall-info-dismiss"),
  firewallInfoOpen: $<HTMLButtonElement>("firewall-info-open"),
};

let lastStatus: StatusView | null = null;
let dirtyPassword = false;

// ipcRenderer.invoke rejects with "Error invoking remote method '<channel>':
// Error: <message>" when the main handler throws. Strip that envelope so the
// user sees just the underlying message instead of Electron internals.
function describeError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;
  const msg = err.message
    .replace(/^Error invoking remote method '[^']*':\s*/, "")
    .replace(/^(?:Uncaught )?Error:\s*/, "")
    .trim();
  return msg || fallback;
}

function setSaveStatus(text: string, kind: "info" | "ok" | "error" = "info") {
  els.saveStatus.textContent = text;
  els.saveStatus.classList.toggle("error", kind === "error");
  els.saveStatus.classList.toggle("ok", kind === "ok");
}

function applyStatus(s: StatusView): void {
  lastStatus = s;

  // Status pill
  els.statusPill.classList.remove("running", "stopped");
  if (s.supervisorStatus === "running") {
    els.statusPill.classList.add("running");
    els.statusPill.textContent = "Running";
  } else if (s.supervisorStatus === "stopped") {
    els.statusPill.classList.add("stopped");
    els.statusPill.textContent = "Stopped";
  } else {
    els.statusPill.textContent = s.supervisorStatus.replace(/^\w/, (c) => c.toUpperCase());
  }

  // Listener URL + QR
  if (s.listenerUrl) {
    els.listenerUrl.textContent = s.listenerUrl;
    els.copyUrl.disabled = false;
    els.openAdmin.disabled = !s.adminUrl;
    els.noLan.hidden = true;
  } else {
    els.listenerUrl.textContent = "—";
    els.copyUrl.disabled = true;
    els.openAdmin.disabled = true;
    els.noLan.hidden = false;
  }

  // Interface picker — only show when there's more than one option, or when
  // the user already has a saved override.
  const showPicker = s.candidates.length > 1 || s.currentInterface != null;
  els.ifaceRow.hidden = !showPicker;
  if (showPicker) {
    renderInterfaceOptions(s);
  }

  // Password — don't clobber while the user is mid-edit.
  if (!dirtyPassword) {
    els.password.value = s.adminPassword;
  }

  // HTTPS / Custom domain — reflect persisted values.
  els.customDomain.value = s.customDomain ?? "";
  els.certFile.value = s.customCertFile ?? "";
  els.keyFile.value = s.customKeyFile ?? "";
  if (s.netcupCustomerId && !els.netcupCustomerId.value) els.netcupCustomerId.value = s.netcupCustomerId;
  if (s.netcupApiKey && !els.netcupApiKey.value) els.netcupApiKey.value = s.netcupApiKey;
  if (s.netcupApiPassword && !els.netcupApiPassword.value) els.netcupApiPassword.value = s.netcupApiPassword;
  updateDnsDisplays();

  // Advanced details
  els.logPathHint.textContent = `Log files: ${s.logDir}`;
  els.versionHint.textContent = `Every Ear ${s.version}`;

  // Firewall warning
  if (s.firewallWarning) {
    els.firewallBanner.hidden = false;
    els.firewallBannerMsg.textContent = s.firewallWarning;
    els.firewallBannerPath.textContent = s.firewallBinaryPath ?? "";
    els.firewallBannerPath.hidden = !s.firewallBinaryPath;
    els.firewallInfoPath.textContent =
      s.firewallBinaryPath ?? "livekit-server";
  } else {
    els.firewallBanner.hidden = true;
    els.firewallInfoModal.hidden = true;
  }

  // First-run modal
  if (s.isFirstRun) {
    els.firstRunPassword.textContent = s.adminPassword;
    els.firstRunModal.hidden = false;
  } else {
    els.firstRunModal.hidden = true;
  }
}

function renderInterfaceOptions(s: StatusView): void {
  const previous = els.ifaceSelect.value;
  els.ifaceSelect.innerHTML = "";

  const auto = document.createElement("option");
  auto.value = "";
  auto.textContent = "Auto (use OS default)";
  els.ifaceSelect.appendChild(auto);

  for (const c of s.candidates) {
    const opt = document.createElement("option");
    opt.value = c.iface;
    opt.textContent = `${c.iface} — ${c.address}${c.isDefaultRoute ? "  (default)" : ""}`;
    els.ifaceSelect.appendChild(opt);
  }

  // Reflect the persisted preference: if the saved interface is in the list,
  // pick it; otherwise leave on Auto.
  const saved = s.candidates.find((c) => c.iface === s.currentInterface);
  els.ifaceSelect.value = saved ? saved.iface : previous || "";
}

// ---- handlers --------------------------------------------------------------

els.copyUrl.addEventListener("click", () => {
  if (lastStatus?.listenerUrl) {
    void window.everyEar.copyToClipboard(lastStatus.listenerUrl);
  }
});

els.openAdmin.addEventListener("click", () => {
  if (lastStatus?.adminUrl) {
    window.open(lastStatus.adminUrl, "_blank", "noopener");
  }
});

els.refreshLan.addEventListener("click", async () => {
  applyStatus(await window.everyEar.getStatus());
});

els.ifaceSelect.addEventListener("change", async () => {
  const value = els.ifaceSelect.value;
  applyStatus(await window.everyEar.setInterface(value || null));
});

els.password.addEventListener("input", () => {
  dirtyPassword = els.password.value !== (lastStatus?.adminPassword ?? "");
  setSaveStatus("");
});

// Neutral line-style eye / eye-off icons (Feather-style strokes).
const EYE_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

function renderPasswordToggle(visible: boolean): void {
  els.togglePassword.innerHTML = visible ? EYE_OFF_ICON : EYE_ICON;
  els.togglePassword.setAttribute("aria-label", visible ? "Hide password" : "Show password");
}
renderPasswordToggle(false);

els.togglePassword.addEventListener("click", () => {
  const visible = els.password.type === "password";
  els.password.type = visible ? "text" : "password";
  renderPasswordToggle(visible);
});

els.copyPassword.addEventListener("click", () => {
  void window.everyEar.copyToClipboard(els.password.value);
  setSaveStatus("Copied.", "ok");
  setTimeout(() => setSaveStatus(""), 1500);
});

els.savePassword.addEventListener("click", async () => {
  const pw = els.password.value;
  if (!pw) {
    setSaveStatus("Password can't be empty.", "error");
    return;
  }
  els.savePassword.disabled = true;
  setSaveStatus("Restarting backend…");
  try {
    const next = await window.everyEar.setAdminPassword(pw);
    dirtyPassword = false;
    applyStatus(next);
    setSaveStatus("Saved. New password is active.", "ok");
  } catch (err) {
    setSaveStatus(describeError(err, "Save failed."), "error");
  } finally {
    els.savePassword.disabled = false;
  }
});

function switchHttpsTab(tab: "manual" | "acme"): void {
  const isManual = tab === "manual";
  els.certTab.classList.toggle("active", isManual);
  els.acmeTab.classList.toggle("active", !isManual);
  els.tabManual.hidden = !isManual;
  els.tabAcme.hidden = isManual;
}

els.certTab.addEventListener("click", () => switchHttpsTab("manual"));
els.acmeTab.addEventListener("click", () => switchHttpsTab("acme"));

// ---- Sidebar navigation ----------------------------------------------------

const navItems = Array.from(document.querySelectorAll<HTMLButtonElement>(".nav-item"));

function switchTab(tab: string): void {
  for (const item of navItems) {
    item.classList.toggle("active", item.dataset.tab === tab);
  }
  for (const panel of document.querySelectorAll<HTMLElement>(".panel")) {
    panel.hidden = panel.id !== `panel-${tab}`;
  }
}

for (const item of navItems) {
  item.addEventListener("click", () => {
    if (item.dataset.tab) switchTab(item.dataset.tab);
  });
}

function setAcmeStatus(text: string, kind: "info" | "ok" | "error" = "info") {
  els.acmeStatus.textContent = text;
  els.acmeStatus.className =
    kind === "error" ? "error" : kind === "ok" ? "ok muted" : "muted";
}

function setHttpsStatus(text: string, kind: "info" | "ok" | "error" = "info") {
  els.httpsStatus.textContent = text;
  els.httpsStatus.className =
    kind === "error" ? "error" : kind === "ok" ? "ok muted" : "muted";
}

els.obtainCert.addEventListener("click", async () => {
  const domain = els.customDomain.value.trim();
  const netcupCustomerId = els.netcupCustomerId.value.trim();
  const netcupApiKey = els.netcupApiKey.value.trim();
  const netcupApiPassword = els.netcupApiPassword.value.trim();

  if (!domain) { setAcmeStatus("Please enter a domain first.", "error"); return; }
  if (!netcupCustomerId || !netcupApiKey || !netcupApiPassword) {
    setAcmeStatus("Enter your Netcup API access on the Netcup tab first.", "error");
    return;
  }

  els.obtainCert.disabled = true;
  setAcmeStatus("Starting… (takes ~1 min)");

  const unsub = window.everyEar.onAcmeProgress((msg) => setAcmeStatus(msg));
  try {
    const next = await window.everyEar.obtainCertificate({
      domain,
      netcupCustomerId,
      netcupApiKey,
      netcupApiPassword,
    });
    applyStatus(next);
    setAcmeStatus("Certificate installed. Caddy restarted.", "ok");
    setTimeout(() => setAcmeStatus(""), 5000);
  } catch (err) {
    setAcmeStatus(describeError(err, "Failed."), "error");
  } finally {
    unsub();
    els.obtainCert.disabled = false;
  }
});

// ---- DNS provider switch + manual flow ------------------------------------

function switchDnsProvider(provider: "netcup" | "manual"): void {
  els.acmeNetcup.hidden = provider !== "netcup";
  els.acmeManual.hidden = provider !== "manual";
}

els.dnsProvider.addEventListener("change", () => {
  switchDnsProvider(els.dnsProvider.value === "manual" ? "manual" : "netcup");
});

// Reflect the typed domain + detected IP in every A-record guide (the manual
// certificate flow on the Certificate tab and the spec on the DNS tab).
function updateDnsDisplays(): void {
  const name = els.customDomain.value.trim() || "events.example.com";
  const value = lastStatus?.currentIp ?? "—";
  els.manualAName.textContent = name;
  els.manualAValue.textContent = value;
  els.dnsAName.textContent = name;
  els.dnsAValue.textContent = value;
}

els.customDomain.addEventListener("input", updateDnsDisplays);

function setAcmeManualStatus(text: string, kind: "info" | "ok" | "error" = "info") {
  els.acmeManualStatus.textContent = text;
  els.acmeManualStatus.className =
    kind === "error" ? "error" : kind === "ok" ? "ok muted" : "muted";
}

els.obtainCertManual.addEventListener("click", async () => {
  const domain = els.customDomain.value.trim();
  if (!domain) { setAcmeManualStatus("Please enter a domain first.", "error"); return; }

  els.obtainCertManual.disabled = true;
  els.manualTxtBox.hidden = true;
  setAcmeManualStatus("Starting…");

  const unsubProgress = window.everyEar.onAcmeProgress((msg) => setAcmeManualStatus(msg));
  const unsubChallenge = window.everyEar.onAcmeChallenge((challenge) => {
    els.manualTxtName.textContent = challenge.recordName;
    els.manualTxtValue.textContent = challenge.recordValue;
    els.manualTxtBox.hidden = false;
  });
  try {
    const next = await window.everyEar.obtainCertificateManual({ domain });
    applyStatus(next);
    setAcmeManualStatus("Certificate installed. Caddy restarted. You can delete the TXT record now.", "ok");
  } catch (err) {
    setAcmeManualStatus(describeError(err, "Failed."), "error");
  } finally {
    unsubProgress();
    unsubChallenge();
    els.obtainCertManual.disabled = false;
  }
});

// Copy buttons inside the manual DNS-record boxes.
for (const btn of document.querySelectorAll<HTMLButtonElement>(".copy-record")) {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset.copy;
    if (!targetId) return;
    const value = document.getElementById(targetId)?.textContent?.trim();
    if (!value || value === "—") return;
    void window.everyEar.copyToClipboard(value);
    const original = btn.textContent;
    btn.textContent = "Copied";
    setTimeout(() => { btn.textContent = original; }, 1200);
  });
}

function setDnsStatus(text: string, kind: "info" | "ok" | "error" = "info") {
  els.dnsStatus.textContent = text;
  els.dnsStatus.className =
    kind === "error" ? "error" : kind === "ok" ? "ok muted" : "muted";
}

els.updateDns.addEventListener("click", async () => {
  const domain = els.customDomain.value.trim();
  const netcupCustomerId = els.netcupCustomerId.value.trim();
  const netcupApiKey = els.netcupApiKey.value.trim();
  const netcupApiPassword = els.netcupApiPassword.value.trim();

  if (!domain) { setDnsStatus("Please enter a domain first.", "error"); return; }
  if (!netcupCustomerId || !netcupApiKey || !netcupApiPassword) {
    setDnsStatus("All three Netcup fields are required.", "error");
    return;
  }

  els.updateDns.disabled = true;
  setDnsStatus("Updating DNS A record…");
  try {
    const res = await window.everyEar.updateDnsRecord({
      domain,
      netcupCustomerId,
      netcupApiKey,
      netcupApiPassword,
    });
    setDnsStatus(res.message, "ok");
    setTimeout(() => setDnsStatus(""), 6000);
  } catch (err) {
    setDnsStatus(describeError(err, "Failed."), "error");
  } finally {
    els.updateDns.disabled = false;
  }
});

els.pickCert.addEventListener("click", async () => {
  const file = await window.everyEar.pickFile({
    title: "Select TLS Certificate",
    filters: [{ name: "PEM Certificate", extensions: ["pem", "crt", "cer"] }],
  });
  if (file) els.certFile.value = file;
});

els.pickKey.addEventListener("click", async () => {
  const file = await window.everyEar.pickFile({
    title: "Select TLS Private Key",
    filters: [{ name: "PEM Private Key", extensions: ["pem", "key"] }],
  });
  if (file) els.keyFile.value = file;
});

els.saveHttps.addEventListener("click", async () => {
  const domain = els.customDomain.value.trim() || null;
  const certFile = els.certFile.value.trim() || null;
  const keyFile = els.keyFile.value.trim() || null;
  if ((certFile && !keyFile) || (!certFile && keyFile)) {
    setHttpsStatus("Both certificate and key files are required together.", "error");
    return;
  }
  els.saveHttps.disabled = true;
  setHttpsStatus("Restarting…");
  try {
    const next = await window.everyEar.setCaddyTls({ domain, certFile, keyFile });
    applyStatus(next);
    setHttpsStatus("Saved. Stack restarted.", "ok");
    setTimeout(() => setHttpsStatus(""), 3000);
  } catch (err) {
    setHttpsStatus(describeError(err, "Save failed."), "error");
  } finally {
    els.saveHttps.disabled = false;
  }
});

els.clearHttps.addEventListener("click", async () => {
  els.customDomain.value = "";
  els.certFile.value = "";
  els.keyFile.value = "";
  els.clearHttps.disabled = true;
  setHttpsStatus("Restarting…");
  try {
    const next = await window.everyEar.setCaddyTls({
      domain: null,
      certFile: null,
      keyFile: null,
    });
    applyStatus(next);
    setHttpsStatus("Reset to internal CA.", "ok");
    setTimeout(() => setHttpsStatus(""), 3000);
  } catch (err) {
    setHttpsStatus(describeError(err, "Reset failed."), "error");
  } finally {
    els.clearHttps.disabled = false;
  }
});

els.regenCreds.addEventListener("click", async () => {
  if (!confirm("Regenerate LiveKit credentials? Active translators will reconnect.")) return;
  els.regenCreds.disabled = true;
  try {
    applyStatus(await window.everyEar.regenerateCredentials());
  } finally {
    els.regenCreds.disabled = false;
  }
});

els.resetData.addEventListener("click", async () => {
  if (!confirm("Reset everything? Events, codes, languages, backgrounds and credentials will be wiped. This cannot be undone.")) return;
  els.resetData.disabled = true;
  try {
    applyStatus(await window.everyEar.resetAllData());
  } finally {
    els.resetData.disabled = false;
  }
});

els.revealLogs.addEventListener("click", () => {
  void window.everyEar.revealLogs();
});

els.firewallOpen.addEventListener("click", () => {
  void window.everyEar.openFirewallSettings();
});

els.firewallRecheck.addEventListener("click", async () => {
  els.firewallRecheck.disabled = true;
  try {
    applyStatus(await window.everyEar.refreshFirewallCheck());
  } finally {
    els.firewallRecheck.disabled = false;
  }
});

function closeFirewallInfo() {
  els.firewallInfoModal.hidden = true;
}

els.firewallInfo.addEventListener("click", () => {
  els.firewallInfoPath.textContent =
    lastStatus?.firewallBinaryPath ?? "livekit-server";
  els.firewallInfoModal.hidden = false;
});

els.firewallInfoClose.addEventListener("click", closeFirewallInfo);
els.firewallInfoDismiss.addEventListener("click", closeFirewallInfo);
els.firewallInfoModal.addEventListener("click", (e) => {
  if (e.target === els.firewallInfoModal) closeFirewallInfo();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.firewallInfoModal.hidden) closeFirewallInfo();
});

els.firewallInfoOpen.addEventListener("click", () => {
  void window.everyEar.openFirewallSettings();
  closeFirewallInfo();
});

els.firstRunCopy.addEventListener("click", async () => {
  if (lastStatus?.adminPassword) {
    await window.everyEar.copyToClipboard(lastStatus.adminPassword);
  }
  await window.everyEar.acknowledgeFirstRun();
  els.firstRunModal.hidden = true;
});

window.everyEar.onStatusChanged((s) => applyStatus(s));

void window.everyEar.getStatus().then(applyStatus);
