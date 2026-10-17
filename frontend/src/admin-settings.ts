// Settings page. Own screen (not a modal) so the admin has room for status,
// setup order and the rarer/destructive actions.

import { toast, confirmDialog, setButtonLoading } from "./ui.js";
import { loadAdminToken, clearAdminToken } from "./session.js";
import { renderAdminNav } from "./admin-nav.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

renderAdminNav(
  "settings",
  "Settings",
  "Everything applies immediately unless a field is marked otherwise.",
);

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

function signOut() {
  clearAdminToken();
  location.replace("/admin-login.html");
}

// ---- Element refs ----------------------------------------------------------

const $restartBanner = document.getElementById("restart-banner") as HTMLDivElement;

const $localUrl = document.getElementById("local-url") as HTMLElement;
const $listenerUrl = document.getElementById("listener-url") as HTMLElement;
const $copyLocal = document.getElementById("copy-local") as HTMLButtonElement;
const $copyListener = document.getElementById("copy-listener") as HTMLButtonElement;
const $livekitState = document.getElementById("livekit-state") as HTMLElement;
const $certSummary = document.getElementById("cert-summary") as HTMLElement;

const $interface = document.getElementById("interface") as HTMLSelectElement;
const $port = document.getElementById("port") as HTMLInputElement;
const $networkSave = document.getElementById("network-save") as HTMLButtonElement;

const $passwordForm = document.getElementById("password-form") as HTMLFormElement;
const $password = document.getElementById("password") as HTMLInputElement;
const $passwordSubmit = document.getElementById("password-submit") as HTMLButtonElement;

const $certDomain = document.getElementById("cert-domain") as HTMLElement;
const $certAutorenew = document.getElementById("cert-autorenew") as HTMLElement;
const $certRenew = document.getElementById("cert-renew") as HTMLButtonElement;
const $domain = document.getElementById("domain") as HTMLInputElement;
const $certNetcup = document.getElementById("cert-netcup") as HTMLButtonElement;
const $certManual = document.getElementById("cert-manual") as HTMLButtonElement;
const $certReset = document.getElementById("cert-reset") as HTMLButtonElement;
const $certPem = document.getElementById("cert-pem") as HTMLTextAreaElement;
const $keyPem = document.getElementById("key-pem") as HTMLTextAreaElement;
const $certOwn = document.getElementById("cert-own") as HTMLButtonElement;
const $netcupKey = document.getElementById("netcup-key") as HTMLInputElement;
const $netcupSave = document.getElementById("netcup-save") as HTMLButtonElement;
const $certStatus = document.getElementById("cert-status") as HTMLElement;

const $regenerate = document.getElementById("regenerate") as HTMLButtonElement;
const $resetData = document.getElementById("reset-data") as HTMLButtonElement;

const $bgForm = document.getElementById("bg-form") as HTMLFormElement;
const $bgFile = document.getElementById("bg-file") as HTMLInputElement;
const $bgFilename = document.getElementById("bg-filename") as HTMLSpanElement;
const $bgPreview = document.getElementById("bg-preview") as HTMLDivElement;
const $bgReset = document.getElementById("bg-reset") as HTMLButtonElement;

// ---- Types -----------------------------------------------------------------

type AdminSettingsResponse = {
  settings: {
    listenerPort: number;
    publicHost: string | null;
    preferredInterface: string | null;
    customDomain: string | null;
    hasNetcupKey: boolean;
  };
  candidates: { iface: string; address: string; isDefaultRoute: boolean }[];
  urls: { listener: string; admin: string; local: string };
  cert: { domain: string | null; daysRemaining: number | null; autoRenew: boolean };
};

// ---- Loading / rendering ---------------------------------------------------

function pill(el: HTMLElement, text: string, kind: "ok" | "warn" | "bad" | "neutral") {
  el.textContent = text;
  el.className = `status-pill ${kind}`;
}

function renderCertStatus(data: AdminSettingsResponse) {
  const { cert } = data;
  const days = cert.daysRemaining;

  if (!cert.domain) {
    $certDomain.textContent = "Using internal certificate";
    pill($certAutorenew, "off — internal certificate", "neutral");
    pill($certSummary, "Internal CA (one-time warning per device)", "warn");
    return;
  }

  $certDomain.textContent = cert.domain;

  if (cert.autoRenew) {
    pill(
      $certAutorenew,
      days != null ? `on — expires in ${days} days` : "on — no certificate yet",
      days != null && days <= 7 ? "warn" : "ok",
    );
    if (days == null) {
      pill($certSummary, "No certificate installed yet", "neutral");
    } else if (days <= 0) {
      pill($certSummary, "Certificate expired", "bad");
    } else if (days <= 14) {
      pill($certSummary, `Expires in ${days} days`, "warn");
    } else {
      pill($certSummary, `Let's Encrypt · ${days} days left`, "ok");
    }
  } else {
    pill($certAutorenew, "off — manual/own certificate", "neutral");
    if (days == null) {
      pill($certSummary, "No readable certificate", "warn");
    } else if (days <= 0) {
      pill($certSummary, "Certificate expired", "bad");
    } else {
      pill($certSummary, `${days} days left (renew manually)`, days <= 14 ? "warn" : "ok");
    }
  }
}

async function refreshStatus() {
  const res = await authedFetch("/api/admin/status");
  if (res.status === 401) return signOut();
  if (!res.ok) return;
  const s = (await res.json()) as { restartRequired: boolean; livekit: string };
  $restartBanner.hidden = !s.restartRequired;
  if (s.livekit === "ok") pill($livekitState, "reachable", "ok");
  else pill($livekitState, "unreachable", "bad");
}

async function loadPage() {
  const res = await authedFetch("/api/admin/settings");
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Could not load settings (HTTP ${res.status})`, "error");
    return;
  }
  const data = (await res.json()) as AdminSettingsResponse;

  $localUrl.textContent = data.urls.local;
  $listenerUrl.textContent = data.urls.listener;
  $domain.value = data.settings.customDomain ?? "";
  $port.value = String(data.settings.listenerPort);

  $interface.innerHTML = "";
  for (const c of data.candidates) {
    const opt = document.createElement("option");
    opt.value = c.iface;
    opt.textContent = `${c.iface} — ${c.address}${c.isDefaultRoute ? " (default)" : ""}`;
    $interface.appendChild(opt);
  }
  if (data.settings.preferredInterface) $interface.value = data.settings.preferredInterface;

  $netcupKey.value = "";
  $netcupKey.placeholder = data.settings.hasNetcupKey
    ? "Saved — leave blank to keep"
    : "64-character REST API key";

  renderCertStatus(data);
  refreshGlobalBackgroundPreview();
  await refreshStatus();
}

function refreshGlobalBackgroundPreview() {
  $bgPreview.style.backgroundImage = `url("/api/background?t=${Date.now()}")`;
}

// ---- Saving ----------------------------------------------------------------

async function saveSettings(patch: Record<string, unknown>): Promise<boolean> {
  const res = await authedFetch("/api/admin/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (res.status === 401) {
    signOut();
    return false;
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast((body as { error?: string }).error ?? `Save failed (HTTP ${res.status})`, "error");
    return false;
  }
  const out = (await res.json()) as { restartRequired?: boolean };
  if (out.restartRequired) $restartBanner.hidden = false;
  return true;
}

/** POST + read an SSE progress stream (certificate issuance / renewal). */
async function streamSse(
  url: string,
  body: unknown,
  onEvent: (ev: {
    progress?: string;
    challenge?: { recordName: string; recordValue: string };
    error?: string;
    done?: boolean;
    listenerUrl?: string;
    result?: string;
  }) => void,
): Promise<void> {
  const res = await authedFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 401) return signOut();
  if (!res.ok || !res.body) {
    toast(`Request failed (HTTP ${res.status})`, "error");
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      try {
        onEvent(JSON.parse(line.slice(5).trim()));
      } catch {
        /* ignore partial / non-JSON lines */
      }
    }
  }
}

// ---- Handlers --------------------------------------------------------------

$copyLocal.addEventListener("click", () => {
  void navigator.clipboard.writeText($localUrl.textContent ?? "").then(() => toast("Copied.", "success"));
});
$copyListener.addEventListener("click", () => {
  void navigator.clipboard.writeText($listenerUrl.textContent ?? "").then(() => toast("Copied.", "success"));
});

$passwordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const pw = $password.value.trim();
  if (!pw) {
    toast("Enter a new password.", "error");
    return;
  }
  setButtonLoading($passwordSubmit, true);
  try {
    if (await saveSettings({ adminPassword: pw })) {
      toast("Password changed.", "success");
      $password.value = "";
    }
  } finally {
    setButtonLoading($passwordSubmit, false);
  }
});

$networkSave.addEventListener("click", async () => {
  const port = Number($port.value);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    toast("Enter a valid port (1–65535).", "error");
    return;
  }
  const ok = await saveSettings({
    preferredInterface: $interface.value,
    listenerPort: port,
  });
  if (ok) {
    toast("Connection settings saved.", "success");
    await refreshStatus();
  }
});

$netcupSave.addEventListener("click", async () => {
  const key = $netcupKey.value.trim();
  if (!key) {
    toast("Enter the netcup REST API key.", "error");
    return;
  }
  if (await saveSettings({ netcupApiKey: key })) {
    toast("Netcup API key saved.", "success");
    $netcupKey.value = "";
    $netcupKey.placeholder = "Saved — leave blank to keep";
  }
});

$certNetcup.addEventListener("click", async () => {
  const domain = $domain.value.trim();
  if (!domain) {
    toast("Enter a domain first.", "error");
    return;
  }
  setButtonLoading($certNetcup, true);
  $certStatus.textContent = "Starting…";
  try {
    await streamSse("/api/admin/certificate/netcup", { domain }, (ev) => {
      if (ev.error) {
        $certStatus.textContent = ev.error;
        toast(ev.error, "error");
      } else if (ev.progress) {
        $certStatus.textContent = ev.progress;
      } else if (ev.done) {
        $certStatus.textContent = `Certificate installed. ${ev.listenerUrl ?? ""}`;
        toast("Certificate installed.", "success");
        void loadPage();
      }
    });
  } finally {
    setButtonLoading($certNetcup, false);
  }
});

$certManual.addEventListener("click", async () => {
  const domain = $domain.value.trim();
  if (!domain) {
    toast("Enter a domain first.", "error");
    return;
  }
  setButtonLoading($certManual, true);
  $certStatus.textContent = "Starting…";
  try {
    await streamSse("/api/admin/certificate/manual", { domain }, (ev) => {
      if (ev.error) {
        $certStatus.textContent = ev.error;
        toast(ev.error, "error");
      } else if (ev.challenge) {
        $certStatus.textContent = `Add this TXT record at your DNS provider: ${ev.challenge.recordName} = ${ev.challenge.recordValue}`;
      } else if (ev.progress) {
        $certStatus.textContent = ev.progress;
      } else if (ev.done) {
        $certStatus.textContent = `Certificate installed. ${ev.listenerUrl ?? ""}`;
        toast("Certificate installed.", "success");
        void loadPage();
      }
    });
  } finally {
    setButtonLoading($certManual, false);
  }
});

$certRenew.addEventListener("click", async () => {
  setButtonLoading($certRenew, true);
  $certStatus.textContent = "Checking certificate…";
  try {
    await streamSse("/api/admin/certificate/renew", {}, (ev) => {
      if (ev.error) {
        $certStatus.textContent = ev.error;
        toast(ev.error, "error");
      } else if (ev.progress) {
        $certStatus.textContent = ev.progress;
      } else if (ev.done) {
        $certStatus.textContent = `Done (${ev.result ?? "ok"}). ${ev.listenerUrl ?? ""}`;
        toast("Certificate check complete.", "success");
        void loadPage();
      }
    });
  } finally {
    setButtonLoading($certRenew, false);
  }
});

$certOwn.addEventListener("click", async () => {
  const certPem = $certPem.value.trim();
  const keyPem = $keyPem.value.trim();
  if (!certPem || !keyPem) {
    toast("Paste both the certificate and the private key.", "error");
    return;
  }
  const res = await authedFetch("/api/admin/certificate/own", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ domain: $domain.value.trim(), certPem, keyPem }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Save failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Certificate saved.", "success");
  $certPem.value = "";
  $keyPem.value = "";
  void loadPage();
});

$certReset.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Reset certificate?",
    message: "Reverts to Caddy's internal certificate, which each device must accept once.",
    confirmLabel: "Reset",
  });
  if (!ok) return;
  const res = await authedFetch("/api/admin/certificate/reset", { method: "POST" });
  if (!res.ok) {
    toast(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Reverted to internal certificate.", "success");
  $certStatus.textContent = "Using Caddy's internal certificate.";
  void loadPage();
});

$regenerate.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Regenerate LiveKit credentials?",
    message: "Rotates the LiveKit key/secret. The stack restarts and active listeners must reconnect.",
    confirmLabel: "Regenerate",
  });
  if (!ok) return;
  const res = await authedFetch("/api/admin/credentials/regenerate", { method: "POST" });
  if (!res.ok) {
    toast(`Failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Credentials rotated. Restart required.", "success");
  await refreshStatus();
});

$resetData.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Reset all event data?",
    message: "Deletes all events, codes, languages, statistics and images. This cannot be undone.",
    confirmLabel: "Reset data",
  });
  if (!ok) return;
  const res = await authedFetch("/api/admin/reset", { method: "POST" });
  if (!res.ok) {
    toast(`Failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Data reset. Restart required.", "success");
  await refreshStatus();
});

// ---- Appearance (default background) ---------------------------------------

$bgFile.addEventListener("change", () => {
  const f = $bgFile.files?.[0];
  $bgFilename.textContent = f?.name ?? "No file chosen";
});

$bgForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = $bgFile.files?.[0];
  if (!f) {
    toast("Pick an image first.", "error");
    return;
  }
  const fd = new FormData();
  fd.append("file", f);
  const res = await authedFetch("/api/admin/background", { method: "POST", body: fd });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast((body as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Default background updated.", "success");
  $bgFile.value = "";
  $bgFilename.textContent = "No file chosen";
  refreshGlobalBackgroundPreview();
});

$bgReset.addEventListener("click", async () => {
  const ok = await confirmDialog({
    title: "Reset default background?",
    message: "Falls back to the image shipped with Every Ear.",
    confirmLabel: "Reset",
  });
  if (!ok) return;
  const res = await authedFetch("/api/admin/background", { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Default background reset.", "success");
  refreshGlobalBackgroundPreview();
});

void loadPage();
