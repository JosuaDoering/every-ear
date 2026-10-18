// Global AI provider configuration (OpenRouter). Per-event AI languages live in
// the event detail page.

import { loadAdminToken, clearAdminToken } from "./session.js";
import { toast, setButtonLoading } from "./ui.js";
import { renderAdminNav } from "./admin-nav.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

renderAdminNav(
  "ai",
  "AI translation",
  "Provider configuration for automatic translation. AI languages are enabled per event.",
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

window.addEventListener("unhandledrejection", (e) => {
  console.error(e.reason);
  toast("Something went wrong. Check the connection and try again.", "error");
  e.preventDefault();
});

const $aiForm = document.getElementById("ai-form") as HTMLFormElement;
const $aiKey = document.getElementById("ai-key") as HTMLInputElement;
const $aiModel = document.getElementById("ai-model") as HTMLSelectElement;
const $aiRefreshModels = document.getElementById("ai-refresh-models") as HTMLButtonElement;
const $aiTemp = document.getElementById("ai-temp") as HTMLInputElement;
const $aiTempReset = document.getElementById("ai-temp-reset") as HTMLButtonElement;
const $aiSubmit = document.getElementById("ai-submit") as HTMLButtonElement;
const $aiStatus = document.getElementById("ai-status") as HTMLSpanElement;
const $aiKeyMasked = document.getElementById("ai-key-masked") as HTMLElement;
const $aiModelCurrent = document.getElementById("ai-model-current") as HTMLElement;
const $aiKeyHint = document.getElementById("ai-key-hint") as HTMLElement;

const RECOMMENDED_TEMPERATURE = 0.3;

function renderStatus(hasKey: boolean, model: string, keyMask: string) {
  const configured = hasKey && Boolean(model);
  $aiStatus.textContent = configured ? "Ready" : hasKey ? "Model missing" : "API key missing";
  $aiStatus.className = `status-pill ${configured ? "ok" : "warn"}`;
  $aiKeyMasked.textContent = hasKey ? keyMask : "not set";
  $aiModelCurrent.textContent = model || "not selected";
}

// Keep a saved/custom model selectable even if it isn't in the catalogue.
function ensureModelOption(model: string) {
  if (!model) return;
  if (!Array.from($aiModel.options).some((o) => o.value === model)) {
    const opt = document.createElement("option");
    opt.value = model;
    opt.textContent = model;
    $aiModel.appendChild(opt);
  }
  $aiModel.value = model;
}

async function loadAiModels(selected?: string) {
  setButtonLoading($aiRefreshModels, true);
  try {
    const res = await authedFetch("/api/admin/ai/models");
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Could not load models (HTTP ${res.status})`, "error");
      return;
    }
    const data = (await res.json()) as { models: { id: string; name: string }[] };
    const current = selected ?? $aiModel.value;
    $aiModel.innerHTML = "";
    for (const m of data.models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      $aiModel.appendChild(opt);
    }
    if (current) ensureModelOption(current);
  } finally {
    setButtonLoading($aiRefreshModels, false);
  }
}

async function loadConfig() {
  const res = await authedFetch("/api/admin/ai-config");
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Could not load AI settings (HTTP ${res.status})`, "error");
    return;
  }
  const cfg = (await res.json()) as {
    openRouterApiKey: string;
    hasKey: boolean;
    model: string;
    temperature: number;
  };
  $aiKey.value = "";
  $aiKey.placeholder = cfg.hasKey ? "Saved — leave blank to keep" : "sk-or-…";
  $aiKeyHint.textContent = cfg.hasKey
    ? `Saved key ${cfg.openRouterApiKey}. Leave blank to keep it.`
    : "Paste a key from openrouter.ai/keys. It is only used server-side.";
  $aiTemp.value = String(cfg.temperature ?? RECOMMENDED_TEMPERATURE);
  renderStatus(cfg.hasKey, cfg.model, cfg.openRouterApiKey);
  await loadAiModels(cfg.model);
}

$aiRefreshModels.addEventListener("click", () => void loadAiModels());

$aiTempReset.addEventListener("click", () => {
  $aiTemp.value = String(RECOMMENDED_TEMPERATURE);
});

$aiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const model = $aiModel.value.trim();
  if (!model) {
    toast("Load the model list and pick a model first.", "error");
    return;
  }
  const payload: Record<string, unknown> = {
    model,
    temperature: Number($aiTemp.value),
  };
  if ($aiKey.value.trim()) payload.openRouterApiKey = $aiKey.value.trim();
  setButtonLoading($aiSubmit, true);
  try {
    const res = await authedFetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Save failed (HTTP ${res.status})`, "error");
      return;
    }
    toast("AI settings saved.", "success");
    $aiKey.value = "";
    // Refresh the masked-key placeholder.
    void loadConfig();
  } finally {
    setButtonLoading($aiSubmit, false);
  }
});

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await loadConfig();
})();
