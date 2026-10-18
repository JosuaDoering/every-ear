// Event detail page: codes, languages, statistics, background, status and
// delete. Replaces the old wide edit modal.

import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";
import {
  escapeHtml,
  toast,
  confirmDialog,
  setButtonLoading,
  inlineEdit,
} from "./ui.js";
import { renderAdminNav } from "./admin-nav.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

renderAdminNav("events", "Event");

const eventId = new URLSearchParams(location.search).get("id");
if (!eventId) {
  location.replace("/admin.html");
  throw new Error("missing event id");
}

// ---- Types -----------------------------------------------------------------

type EventEntry = {
  id: string;
  name: string;
  languages: string[];
  aiLanguages?: string[];
  aiSourceLang?: string;
  backgroundExt?: string;
  createdAt: string;
  active?: boolean;
};

type CodeEntry = {
  code: string;
  eventId: string;
  language: string;
  name: string;
  role?: "translator" | "ai-operator";
  createdAt: string;
  lastUsedAt?: string;
};

type ChannelStat = {
  language: string;
  ai: boolean;
  activeListeners: number;
  listeners24h: number;
  broadcastSeconds: number;
};

type HistoryPoint = { t: number; n: number };

// ---- Refs ------------------------------------------------------------------

const $detailName = document.getElementById("detail-name") as HTMLHeadingElement;
const $detailMeta = document.getElementById("detail-meta") as HTMLParagraphElement;
const $detailLanguages = document.getElementById("detail-languages") as HTMLDivElement;
const $detailAiLanguages = document.getElementById("detail-ai-languages") as HTMLDivElement;
const $detailAiSource = document.getElementById("detail-ai-source") as HTMLSelectElement;
const $detailSaveLangs = document.getElementById("detail-save-langs") as HTMLButtonElement;
const $detailStats = document.getElementById("detail-stats") as HTMLDivElement;
const $detailHistory = document.getElementById("detail-history") as HTMLDivElement;
const $detailBgPreview = document.getElementById("detail-bg-preview") as HTMLDivElement;
const $detailBgForm = document.getElementById("detail-bg-form") as HTMLFormElement;
const $detailBgFile = document.getElementById("detail-bg-file") as HTMLInputElement;
const $detailBgFilename = document.getElementById("detail-bg-filename") as HTMLSpanElement;
const $detailBgReset = document.getElementById("detail-bg-reset") as HTMLButtonElement;
const $detailDelete = document.getElementById("detail-delete") as HTMLButtonElement;
const $detailToggleActive = document.getElementById("detail-toggle-active") as HTMLButtonElement;
const $detailStatusLabel = document.getElementById("detail-status-label") as HTMLElement;
const $detailStatusZone = $detailToggleActive.closest(".status-zone") as HTMLDivElement;

const $codeLanguage = document.getElementById("code-language") as HTMLSelectElement;
const $codeName = document.getElementById("code-name") as HTMLInputElement;
const $codeForm = document.getElementById("code-form") as HTMLFormElement;
const $codeSubmit = document.getElementById("code-submit") as HTMLButtonElement;
const $codeList = document.getElementById("code-list") as HTMLDivElement;
const $aiCodeForm = document.getElementById("ai-code-form") as HTMLFormElement;
const $aiCodeName = document.getElementById("ai-code-name") as HTMLInputElement;
const $aiCodeSubmit = document.getElementById("ai-code-submit") as HTMLButtonElement;
const $codeAddBtn = document.getElementById("code-add-btn") as HTMLButtonElement;
const $codeAddMenu = document.getElementById("code-add-menu") as HTMLDivElement;
const $codeAddTranslator = document.getElementById("code-add-translator") as HTMLButtonElement;
const $codeAddAi = document.getElementById("code-add-ai") as HTMLButtonElement;

// ---- State + helpers -------------------------------------------------------

let languages: Language[] = [];
let event: EventEntry | null = null;
let codes: CodeEntry[] = [];
let statsTimer: number | null = null;

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


function formatRelative(iso: string, label: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const min = Math.round(diffMs / 60000);
  if (min < 1) return `${label} just now`;
  if (min < 60) return `${label} ${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${label} ${h} h ago`;
  return `${label} ${d.toLocaleDateString()}`;
}

// ---- Language pickers ------------------------------------------------------

function renderLangPicker(target: HTMLDivElement, selected: Set<string>) {
  target.innerHTML = "";
  if (languages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "muted";
    empty.textContent = "No languages configured. Open “Languages” to add some.";
    target.appendChild(empty);
    return;
  }
  for (const l of languages) {
    const wrap = document.createElement("label");
    wrap.className = "lang-chip";
    wrap.innerHTML = `<input type="checkbox" value="${escapeHtml(l.code)}" ${
      selected.has(l.code) ? "checked" : ""
    }><span>${escapeHtml(l.flag)} ${escapeHtml(l.name)}</span>`;
    target.appendChild(wrap);
  }
}

function selectedFromPicker(target: HTMLDivElement): string[] {
  return Array.from(
    target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
  ).map((i) => i.value);
}

// A language can be manual or AI, never both.
function applyExclusion() {
  const manual = new Set(selectedFromPicker($detailLanguages));
  const ai = new Set(selectedFromPicker($detailAiLanguages));
  const sync = (target: HTMLDivElement, blocked: Set<string>) => {
    for (const input of target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) {
      const off = !input.checked && blocked.has(input.value);
      input.disabled = off;
      input.closest(".lang-chip")?.classList.toggle("disabled", off);
    }
  };
  sync($detailLanguages, ai);
  sync($detailAiLanguages, manual);
}

$detailLanguages.addEventListener("change", applyExclusion);
$detailAiLanguages.addEventListener("change", applyExclusion);

function renderAiSourceOptions() {
  if (!event) return;
  $detailAiSource.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— none —";
  $detailAiSource.appendChild(none);
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = `${l.flag}  ${l.name}`;
    $detailAiSource.appendChild(opt);
  }
  $detailAiSource.value = event.aiSourceLang ?? "";
}

// ---- Loading / rendering ---------------------------------------------------

function updateMeta() {
  if (!event) return;
  const langCount = event.languages.length;
  const codeCount = codes.length;
  $detailMeta.textContent = `${langCount} language${
    langCount === 1 ? "" : "s"
  } · ${codeCount} code${codeCount === 1 ? "" : "s"} · created ${new Date(
    event.createdAt,
  ).toLocaleDateString()} · click name to rename`;
}

function renderEvent() {
  if (!event) return;
  $detailName.textContent = event.name;
  document.title = `Every Ear · ${event.name}`;
  updateMeta();

  renderLangPicker($detailLanguages, new Set(event.languages));
  renderLangPicker($detailAiLanguages, new Set(event.aiLanguages ?? []));
  renderAiSourceOptions();
  applyExclusion();

  $detailBgPreview.style.backgroundImage = `url("/api/events/${event.id}/background?t=${Date.now()}")`;

  renderCodeLanguageOptions();
  resetCodeAdd();

  const isActive = event.active !== false;
  $detailStatusLabel.textContent = isActive ? "Event is active" : "Event is inactive";
  $detailToggleActive.querySelector("span")!.textContent = isActive ? "Deactivate" : "Activate";
  $detailStatusZone.classList.toggle("is-inactive", !isActive);
}

function renderCodeLanguageOptions() {
  if (!event) return;
  $codeLanguage.innerHTML = "";
  const opts = languages.filter((l) => event!.languages.includes(l.code));
  if (opts.length === 0) {
    const opt = document.createElement("option");
    opt.disabled = true;
    opt.selected = true;
    opt.textContent = "Add languages first";
    $codeLanguage.appendChild(opt);
    return;
  }
  for (const l of opts) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = `${l.flag}  ${l.name}`;
    $codeLanguage.appendChild(opt);
  }
}

async function loadEvent() {
  const res = await authedFetch("/api/admin/events");
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Failed to load events (HTTP ${res.status})`, "error");
    return;
  }
  const data = (await res.json()) as { events: EventEntry[] };
  event = data.events.find((e) => e.id === eventId) ?? null;
  if (!event) {
    toast("Event not found.", "error");
    location.replace("/admin.html");
    return;
  }
  renderEvent();
}

async function reloadAll() {
  await loadEvent();
  await refreshCodes();
  await refreshChannelStats();
}

// Rename on click.
inlineEdit({
  element: $detailName,
  onCommit: async (next) => {
    if (!event || next === event.name) return;
    const res = await authedFetch(`/api/admin/events/${event.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Rename failed (HTTP ${res.status})`, "error");
      $detailName.textContent = event.name;
      return;
    }
    toast(`Renamed to "${next}".`, "success");
    await reloadAll();
  },
});

// ---- Codes -----------------------------------------------------------------

async function refreshCodes() {
  if (!event) return;
  const res = await authedFetch(`/api/admin/codes?eventId=${encodeURIComponent(event.id)}`);
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Failed to load codes (HTTP ${res.status})`, "error");
    return;
  }
  const data = (await res.json()) as { codes: CodeEntry[] };
  codes = data.codes;
  renderCodes();
  updateMeta();
}

function renderCodes() {
  $codeList.innerHTML = "";
  if (codes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No codes yet for this event — generate one below.";
    $codeList.appendChild(empty);
    return;
  }
  for (const c of codes) {
    const isAi = c.role === "ai-operator";
    const lang = languages.find((l) => l.code === c.language);
    const row = document.createElement("div");
    row.className = "code-row";

    const codeEl = document.createElement("div");
    codeEl.className = "code-value";
    codeEl.textContent = c.code;

    const meta = document.createElement("div");
    meta.className = "code-meta";
    const langChip = isAi
      ? `<span class="code-lang ai-pill">🤖 AI operator</span>`
      : `<span class="code-lang">${escapeHtml(lang?.flag ?? "🏳️")} ${escapeHtml(
          lang?.name ?? c.language.toUpperCase(),
        )}</span>`;
    meta.innerHTML = `<strong>${escapeHtml(c.name)}</strong>
      ${langChip}
      <span class="code-time">${formatRelative(
        c.lastUsedAt ?? c.createdAt,
        c.lastUsedAt ? "used" : "created",
      )}</span>`;

    const revoke = document.createElement("button");
    revoke.className = "danger outline small";
    revoke.innerHTML = "<span>Revoke</span>";
    revoke.addEventListener("click", () => revokeCode(c.code, c.name));

    row.appendChild(codeEl);
    row.appendChild(meta);
    row.appendChild(revoke);
    $codeList.appendChild(row);
  }
}

async function revokeCode(code: string, name: string) {
  const ok = await confirmDialog({
    title: `Revoke code ${code}?`,
    message: `${name} won't be able to broadcast until you generate a new code.`,
    confirmLabel: "Revoke code",
    danger: true,
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/codes/${code}`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Revoke failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(`Code ${code} revoked.`, "success");
  await refreshCodes();
}

// "Add code" dropdown.
function closeCodeAddMenu() {
  $codeAddMenu.hidden = true;
  $codeAddBtn.setAttribute("aria-expanded", "false");
}

function resetCodeAdd() {
  $codeForm.hidden = true;
  $aiCodeForm.hidden = true;
  closeCodeAddMenu();
}

$codeAddBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  const willOpen = $codeAddMenu.hidden;
  $codeAddMenu.hidden = !willOpen;
  $codeAddBtn.setAttribute("aria-expanded", String(willOpen));
});

$codeAddTranslator.addEventListener("click", () => {
  $aiCodeForm.hidden = true;
  $codeForm.hidden = false;
  closeCodeAddMenu();
  $codeName.focus();
});

$codeAddAi.addEventListener("click", () => {
  $codeForm.hidden = true;
  $aiCodeForm.hidden = false;
  closeCodeAddMenu();
  $aiCodeName.focus();
});

document.addEventListener("click", (e) => {
  if (!$codeAddMenu.hidden && !$codeAddMenu.contains(e.target as Node)) {
    closeCodeAddMenu();
  }
});

$codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!event) return;
  const language = $codeLanguage.value;
  const name = $codeName.value.trim();
  if (!language) {
    toast("Pick a language for the code.", "error");
    return;
  }
  if (!name) {
    toast("Translator name is required.", "error");
    $codeName.focus();
    return;
  }
  setButtonLoading($codeSubmit, true);
  try {
    const res = await authedFetch("/api/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, language, name }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Could not generate code (HTTP ${res.status})`, "error");
      return;
    }
    const created = (await res.json()) as CodeEntry;
    toast(`Code ${created.code} created for ${created.name}.`, "success");
    $codeName.value = "";
    await refreshCodes();
  } finally {
    setButtonLoading($codeSubmit, false);
  }
});

$aiCodeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!event) return;
  const name = $aiCodeName.value.trim();
  if (!name) {
    toast("AI operator name is required.", "error");
    $aiCodeName.focus();
    return;
  }
  setButtonLoading($aiCodeSubmit, true);
  try {
    const res = await authedFetch("/api/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventId: event.id, name, role: "ai-operator" }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast(
        (body as { error?: string }).error ?? `Could not generate code (HTTP ${res.status})`,
        "error",
      );
      return;
    }
    const created = (await res.json()) as CodeEntry;
    toast(`AI-operator code ${created.code} created.`, "success");
    $aiCodeName.value = "";
    await refreshCodes();
  } finally {
    setButtonLoading($aiCodeSubmit, false);
  }
});

// ---- Languages save --------------------------------------------------------

$detailSaveLangs.addEventListener("click", async () => {
  if (!event) return;
  const langs = selectedFromPicker($detailLanguages);
  const aiLangs = selectedFromPicker($detailAiLanguages);
  const aiSource = $detailAiSource.value || null;
  setButtonLoading($detailSaveLangs, true);
  try {
    const res = await authedFetch(`/api/admin/events/${event.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        languages: langs,
        aiLanguages: aiLangs,
        aiSourceLang: aiSource,
      }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast((body as { error?: string }).error ?? `Save failed (HTTP ${res.status})`, "error");
      return;
    }
    toast("Languages saved.", "success");
    await reloadAll();
  } finally {
    setButtonLoading($detailSaveLangs, false);
  }
});

// ---- Background ------------------------------------------------------------

$detailBgFile.addEventListener("change", () => {
  const f = $detailBgFile.files?.[0];
  $detailBgFilename.textContent = f?.name ?? "No file chosen";
});

$detailBgForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!event) return;
  const f = $detailBgFile.files?.[0];
  if (!f) {
    toast("Pick an image first.", "error");
    return;
  }
  const fd = new FormData();
  fd.append("file", f);
  const res = await authedFetch(`/api/admin/events/${event.id}/background`, {
    method: "POST",
    body: fd,
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast((body as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Event background updated.", "success");
  $detailBgFile.value = "";
  $detailBgFilename.textContent = "No file chosen";
  $detailBgPreview.style.backgroundImage = `url("/api/events/${event.id}/background?t=${Date.now()}")`;
});

$detailBgReset.addEventListener("click", async () => {
  if (!event) return;
  const ok = await confirmDialog({
    title: "Use default background?",
    message: "This event will fall back to the default image.",
    confirmLabel: "Use default",
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/events/${event.id}/background`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Event background cleared.", "success");
  $detailBgPreview.style.backgroundImage = `url("/api/events/${event.id}/background?t=${Date.now()}")`;
});

// ---- Status / delete -------------------------------------------------------

$detailToggleActive.addEventListener("click", async () => {
  if (!event) return;
  const isActive = event.active !== false;
  const res = await authedFetch(`/api/admin/events/${event.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: !isActive }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Update failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(
    isActive ? `"${event.name}" set to inactive.` : `"${event.name}" is active again.`,
    "success",
  );
  await reloadAll();
});

$detailDelete.addEventListener("click", async () => {
  if (!event) return;
  const ok = await confirmDialog({
    title: `Delete "${event.name}"?`,
    message: "Removes the event and every translator code attached to it. This cannot be undone.",
    confirmLabel: "Delete event",
    danger: true,
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/events/${event.id}`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Delete failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(`Event "${event.name}" deleted.`, "success");
  location.replace("/admin.html");
});

// ---- Statistics ------------------------------------------------------------

function formatBroadcast(seconds: number): string {
  if (seconds <= 0) return "none yet";
  if (seconds < 60) return `${seconds}s`;
  const totalMin = Math.floor(seconds / 60);
  if (totalMin < 60) return `${totalMin} min`;
  const h = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min ? `${h} h ${min} min` : `${h} h`;
}

async function refreshChannelStats() {
  if (!event) return;
  const res = await authedFetch(`/api/admin/events/${encodeURIComponent(event.id)}/stats`);
  if (res.status === 401) return signOut();
  if (!res.ok) {
    $detailStats.innerHTML = `<div class="empty">Statistics unavailable (HTTP ${res.status}).</div>`;
    return;
  }
  const data = (await res.json()) as { channels: ChannelStat[]; history: HistoryPoint[] };
  renderChannelStats(data.channels);
  renderHistoryChart(data.history ?? []);
}

function renderChannelStats(channels: ChannelStat[]) {
  $detailStats.innerHTML = "";
  if (channels.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No language channels for this event yet.";
    $detailStats.appendChild(empty);
    return;
  }
  for (const c of channels) {
    const lang = languages.find((l) => l.code === c.language);
    const row = document.createElement("div");
    row.className = "stat-row";
    const label = `${escapeHtml(lang?.flag ?? "🏳️")} ${escapeHtml(
      lang?.name ?? c.language.toUpperCase(),
    )}${c.ai ? ' <span class="ai-pill">🤖 AI</span>' : ""}`;
    row.innerHTML = `
      <div class="stat-channel">${label}</div>
      <div class="stat-metrics">
        <span class="stat-metric"><strong>${c.activeListeners}</strong><span class="stat-metric-label">active now</span></span>
        <span class="stat-metric"><strong>${c.listeners24h}</strong><span class="stat-metric-label">last 24 h</span></span>
        <span class="stat-metric"><strong>${formatBroadcast(c.broadcastSeconds)}</strong><span class="stat-metric-label">broadcast</span></span>
      </div>`;
    $detailStats.appendChild(row);
  }
}

const HISTORY_BUCKET_MS = 5 * 60 * 1000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

function renderHistoryChart(history: HistoryPoint[]) {
  const now = Date.now();
  const startBucket =
    Math.floor((now - HISTORY_WINDOW_MS) / HISTORY_BUCKET_MS) * HISTORY_BUCKET_MS;
  const byBucket = new Map(history.map((p) => [p.t, p.n]));

  const series: HistoryPoint[] = [];
  for (let t = startBucket; t <= now; t += HISTORY_BUCKET_MS) {
    series.push({ t, n: byBucket.get(t) ?? 0 });
  }

  const peak = Math.max(0, ...series.map((p) => p.n));
  if (peak === 0) {
    $detailHistory.hidden = true;
    $detailHistory.innerHTML = "";
    return;
  }

  const W = 600;
  const H = 140;
  const padY = 10;
  const maxN = Math.max(1, peak);
  const stepX = W / Math.max(1, series.length - 1);
  const coords = series.map((p, i) => {
    const x = i * stepX;
    const y = H - padY - (p.n / maxN) * (H - 2 * padY);
    return [x, y] as const;
  });
  const line = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const first = coords[0]?.[0] ?? 0;
  const last = coords[coords.length - 1]?.[0] ?? W;
  const area = `${first.toFixed(1)},${H} ${line} ${last.toFixed(1)},${H}`;

  $detailHistory.hidden = false;
  $detailHistory.innerHTML = `
    <div class="chart-head">
      <span class="chart-title">Concurrent listeners · last 24 h</span>
      <span class="chart-peak">peak ${peak}</span>
    </div>
    <div class="chart-plot">
      <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
        <polygon class="chart-area" points="${area}"></polygon>
        <polyline class="chart-line" points="${line}"></polyline>
      </svg>
      <div class="chart-cursor" hidden></div>
      <div class="chart-dot" hidden></div>
      <div class="chart-tooltip" hidden></div>
    </div>
    <div class="chart-axis"><span>24 h ago</span><span>now</span></div>`;

  const plot = $detailHistory.querySelector<HTMLDivElement>(".chart-plot")!;
  const cursor = plot.querySelector<HTMLDivElement>(".chart-cursor")!;
  const dot = plot.querySelector<HTMLDivElement>(".chart-dot")!;
  const tip = plot.querySelector<HTMLDivElement>(".chart-tooltip")!;

  const onMove = (clientX: number) => {
    const rect = plot.getBoundingClientRect();
    if (rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const i = Math.round(frac * (series.length - 1));
    const p = series[i];
    const c = coords[i];
    if (!p || !c) return;
    const px = (c[0] / W) * rect.width;
    const py = (c[1] / H) * rect.height;

    cursor.style.left = `${px}px`;
    cursor.hidden = false;
    dot.style.left = `${px}px`;
    dot.style.top = `${py}px`;
    dot.hidden = false;

    const when = new Date(p.t).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    tip.innerHTML = `<strong>${p.n}</strong> listener${p.n === 1 ? "" : "s"}<span>${when}</span>`;
    const half = tip.offsetWidth / 2;
    tip.style.left = `${Math.min(rect.width - half, Math.max(half, px))}px`;
    tip.hidden = false;
  };

  const hide = () => {
    cursor.hidden = true;
    dot.hidden = true;
    tip.hidden = true;
  };

  plot.addEventListener("mousemove", (e) => onMove(e.clientX));
  plot.addEventListener("mouseleave", hide);
  plot.addEventListener("touchmove", (e) => {
    const t = e.touches[0];
    if (t) onMove(t.clientX);
  });
  plot.addEventListener("touchend", hide);
}

// ---- Init ------------------------------------------------------------------

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();

  languages = await fetchLanguages();
  await loadEvent();
  if (!event) return;
  await refreshCodes();
  await refreshChannelStats();

  if (statsTimer) clearInterval(statsTimer);
  statsTimer = window.setInterval(() => void refreshChannelStats(), 10_000);
  window.addEventListener("beforeunload", () => {
    if (statsTimer) clearInterval(statsTimer);
  });
})();
