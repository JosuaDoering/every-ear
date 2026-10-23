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

const $sttForm = document.getElementById("stt-form") as HTMLFormElement;
const $sttEngine = document.getElementById("stt-engine") as HTMLSelectElement;
const $sttEngineCurrent = document.getElementById("stt-engine-current") as HTMLElement;
const $sttSubmit = document.getElementById("stt-submit") as HTMLButtonElement;
const $groqFields = document.getElementById("groq-fields") as HTMLDivElement;
const $groqKey = document.getElementById("groq-key") as HTMLInputElement;
const $groqKeyHint = document.getElementById("groq-key-hint") as HTMLElement;
const $groqKeyMasked = document.getElementById("groq-key-masked") as HTMLElement;
const $groqModel = document.getElementById("groq-model") as HTMLSelectElement;
const $groqModelCurrent = document.getElementById("groq-model-current") as HTMLElement;

const RECOMMENDED_TEMPERATURE = 0.3;

const ENGINE_LABELS: Record<string, string> = {
  "web-speech": "Browser (Web Speech API)",
  groq: "Groq Whisper",
};

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

function syncGroqVisibility() {
  $groqFields.hidden = $sttEngine.value !== "groq";
}

function renderSttStatus(engine: string, groqHasKey: boolean, groqKeyMask: string, groqModel: string) {
  $sttEngineCurrent.textContent = ENGINE_LABELS[engine] ?? engine;
  $groqKeyMasked.textContent = groqHasKey ? groqKeyMask : "not set";
  $groqModelCurrent.textContent = groqModel;
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
    sttEngine: string;
    groqApiKey: string;
    groqHasKey: boolean;
    groqSttModel: string;
  };
  $aiKey.value = "";
  $aiKey.placeholder = cfg.hasKey ? "Saved — leave blank to keep" : "sk-or-…";
  $aiKeyHint.textContent = cfg.hasKey
    ? `Saved key ${cfg.openRouterApiKey}. Leave blank to keep it.`
    : "Paste a key from openrouter.ai/keys. It is only used server-side.";
  $aiTemp.value = String(cfg.temperature ?? RECOMMENDED_TEMPERATURE);
  renderStatus(cfg.hasKey, cfg.model, cfg.openRouterApiKey);

  $sttEngine.value = cfg.sttEngine === "groq" ? "groq" : "web-speech";
  $groqModel.value = cfg.groqSttModel || "whisper-large-v3-turbo";
  $groqKey.value = "";
  $groqKey.placeholder = cfg.groqHasKey ? "Saved — leave blank to keep" : "gsk_…";
  $groqKeyHint.textContent = cfg.groqHasKey
    ? `Saved key ${cfg.groqApiKey}. Leave blank to keep it.`
    : "Paste a key from console.groq.com/keys. It is only used server-side.";
  renderSttStatus(cfg.sttEngine, cfg.groqHasKey, cfg.groqApiKey, cfg.groqSttModel);
  syncGroqVisibility();

  await loadAiModels(cfg.model);
}

$aiRefreshModels.addEventListener("click", () => void loadAiModels());

$aiTempReset.addEventListener("click", () => {
  $aiTemp.value = String(RECOMMENDED_TEMPERATURE);
});

$sttEngine.addEventListener("change", syncGroqVisibility);

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

$sttForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload: Record<string, unknown> = {
    sttEngine: $sttEngine.value,
  };
  if ($sttEngine.value === "groq") {
    if ($groqKey.value.trim()) payload.groqApiKey = $groqKey.value.trim();
    payload.groqSttModel = $groqModel.value;
  }
  setButtonLoading($sttSubmit, true);
  try {
    const res = await authedFetch("/api/admin/ai-config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      toast(`Save failed: ${data.error ?? `HTTP ${res.status}`}`, "error");
      return;
    }
    toast("Speech-to-text settings saved.", "success");
    $groqKey.value = "";
    void loadConfig();
  } finally {
    setButtonLoading($sttSubmit, false);
  }
});

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await loadConfig();
})();
