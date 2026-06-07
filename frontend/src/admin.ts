import QRCode from "qrcode";
import { renderPoster, type WifiAuth } from "./poster.js";
import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";
import { toast, confirmDialog, setButtonLoading, inlineEdit } from "./ui.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

const $logoutBtn = document.getElementById("admin-logout") as HTMLButtonElement;
const $openLanguages = document.getElementById("open-languages") as HTMLButtonElement;

const $eventGrid = document.getElementById("event-grid") as HTMLDivElement;

// New-event modal.
const $newModal = document.getElementById("modal-backdrop") as HTMLDivElement;
const $newModalClose = document.getElementById("modal-close") as HTMLButtonElement;
const $newModalCancel = document.getElementById("modal-cancel") as HTMLButtonElement;
const $eventForm = document.getElementById("event-form") as HTMLFormElement;
const $eventNameInput = document.getElementById("event-name") as HTMLInputElement;
const $eventLanguagesPicker = document.getElementById("event-languages") as HTMLDivElement;
const $modalSubmit = document.getElementById("modal-submit") as HTMLButtonElement;

// Edit-event modal.
const $eventModal = document.getElementById("event-modal-backdrop") as HTMLDivElement;
const $eventModalClose = document.getElementById("event-modal-close") as HTMLButtonElement;
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

// AI settings modal.
const $openAiSettings = document.getElementById("open-ai-settings") as HTMLButtonElement;
const $aiModal = document.getElementById("ai-modal-backdrop") as HTMLDivElement;
const $aiModalClose = document.getElementById("ai-modal-close") as HTMLButtonElement;
const $aiForm = document.getElementById("ai-form") as HTMLFormElement;
const $aiKey = document.getElementById("ai-key") as HTMLInputElement;
const $aiModel = document.getElementById("ai-model") as HTMLSelectElement;
const $aiRefreshModels = document.getElementById("ai-refresh-models") as HTMLButtonElement;
const $aiTemp = document.getElementById("ai-temp") as HTMLInputElement;
const $aiSubmit = document.getElementById("ai-submit") as HTMLButtonElement;

// Languages modal.
const $langModal = document.getElementById("lang-modal-backdrop") as HTMLDivElement;
const $langModalClose = document.getElementById("lang-modal-close") as HTMLButtonElement;
const $langList = document.getElementById("lang-list") as HTMLDivElement;
const $addLangForm = document.getElementById("add-lang-form") as HTMLFormElement;
const $addLangCode = document.getElementById("add-lang-code") as HTMLInputElement;
const $addLangFlag = document.getElementById("add-lang-flag") as HTMLInputElement;
const $addLangName = document.getElementById("add-lang-name") as HTMLInputElement;

// QR codes.
const $qrListener   = document.getElementById("qr-listener")     as HTMLCanvasElement;
const $qrTranslator = document.getElementById("qr-translator")   as HTMLCanvasElement;
const $qrListenerUrl   = document.getElementById("qr-listener-url")   as HTMLElement;
const $qrTranslatorUrl = document.getElementById("qr-translator-url") as HTMLElement;
const $copyListener   = document.getElementById("copy-listener")   as HTMLButtonElement;
const $copyTranslator = document.getElementById("copy-translator") as HTMLButtonElement;

// Connection poster.
const $wifiSsid          = document.getElementById("wifi-ssid")          as HTMLInputElement;
const $wifiAuth          = document.getElementById("wifi-auth")          as HTMLSelectElement;
const $wifiPasswordLabel = document.getElementById("wifi-password-label") as HTMLLabelElement;
const $wifiPassword      = document.getElementById("wifi-password")      as HTMLInputElement;
const $wifiPasswordToggle = document.getElementById("wifi-password-toggle") as HTMLButtonElement;
const $wifiHidden        = document.getElementById("wifi-hidden")        as HTMLInputElement;
const $posterListener    = document.getElementById("poster-listener")    as HTMLButtonElement;
const $posterTranslator  = document.getElementById("poster-translator")  as HTMLButtonElement;
const $posterStatus      = document.getElementById("poster-status")      as HTMLSpanElement;
const $posterPreview     = document.getElementById("poster-preview")     as HTMLDivElement;
const $posterCanvas      = document.getElementById("poster-canvas")      as HTMLCanvasElement;
const $posterActions     = document.getElementById("poster-actions")     as HTMLDivElement;
const $downloadPoster    = document.getElementById("download-poster")    as HTMLButtonElement;
const $copyPoster        = document.getElementById("copy-poster")        as HTMLButtonElement;

// Default-background block.
const $bgForm = document.getElementById("bg-form") as HTMLFormElement;
const $bgFile = document.getElementById("bg-file") as HTMLInputElement;
const $bgFilename = document.getElementById("bg-filename") as HTMLSpanElement;
const $bgPreview = document.getElementById("bg-preview") as HTMLDivElement;
const $bgReset = document.getElementById("bg-reset") as HTMLButtonElement;

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

let languages: Language[] = [];
let events: EventEntry[] = [];
let codeCounts = new Map<string, number>();
let openEditEventId: string | null = null;
let statsTimer: number | null = null;

function authedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return fetch(url, { ...init, headers });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

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

function signOut() {
  clearAdminToken();
  location.replace("/admin-login.html");
}

// ---- Modal plumbing --------------------------------------------------------

const modalStack: HTMLDivElement[] = [];

function openModalEl(el: HTMLDivElement) {
  if (!modalStack.includes(el)) modalStack.push(el);
  el.hidden = false;
}

function closeModalEl(el: HTMLDivElement) {
  el.hidden = true;
  const i = modalStack.indexOf(el);
  if (i >= 0) modalStack.splice(i, 1);
}

function topModal(): HTMLDivElement | null {
  return modalStack[modalStack.length - 1] ?? null;
}

function bindBackdropClose(backdrop: HTMLDivElement, onClose: () => void) {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) onClose();
  });
}

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  const top = topModal();
  if (!top) return;
  if (top === $newModal) closeNewEventModal();
  else if (top === $eventModal) closeEditEventModal();
  else if (top === $langModal) closeLanguagesModal();
  else if (top === $aiModal) closeAiSettings();
});

// ---- Language picker (chip checkboxes) ------------------------------------

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
    }><span>${l.flag} ${escapeHtml(l.name)}</span>`;
    target.appendChild(wrap);
  }
}

function selectedFromPicker(target: HTMLDivElement): string[] {
  return Array.from(
    target.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:checked'),
  ).map((i) => i.value);
}

// Mutual exclusion: a code checked as a manual language is disabled in the AI
// picker and vice versa. Re-derived on every change to either picker.
function applyExclusion() {
  const manual = new Set(selectedFromPicker($detailLanguages));
  const ai = new Set(selectedFromPicker($detailAiLanguages));
  const sync = (target: HTMLDivElement, blocked: Set<string>) => {
    for (const input of target.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )) {
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

function renderAiSourceOptions(ev: EventEntry) {
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
  $detailAiSource.value = ev.aiSourceLang ?? "";
}

// ---- Data loading ----------------------------------------------------------

async function loadLanguages() {
  languages = await fetchLanguages();
}

async function fetchAllCodes(): Promise<CodeEntry[]> {
  const res = await authedFetch("/api/admin/codes");
  if (res.status === 401) {
    signOut();
    return [];
  }
  if (!res.ok) {
    toast(`Failed to load codes (HTTP ${res.status})`, "error");
    return [];
  }
  const data = (await res.json()) as { codes: CodeEntry[] };
  return data.codes;
}

async function refreshAll() {
  await loadLanguages();
  const [eventsRes, allCodes] = await Promise.all([
    authedFetch("/api/admin/events"),
    fetchAllCodes(),
  ]);
  if (eventsRes.status === 401) return signOut();
  if (!eventsRes.ok) {
    toast(`Failed to load events (HTTP ${eventsRes.status})`, "error");
    return;
  }
  const data = (await eventsRes.json()) as { events: EventEntry[] };
  events = data.events;
  codeCounts = new Map();
  for (const c of allCodes) {
    codeCounts.set(c.eventId, (codeCounts.get(c.eventId) ?? 0) + 1);
  }
  renderEventGrid();
  if (openEditEventId) {
    const stillExists = events.some((e) => e.id === openEditEventId);
    if (!stillExists) {
      closeEditEventModal();
    } else {
      renderEditEventModal();
    }
  }
}

// ---- Event card grid -------------------------------------------------------

function renderEventGrid() {
  $eventGrid.innerHTML = "";

  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-empty";
    empty.innerHTML = `
      <span class="icon">📅</span>
      <span class="title">No events yet</span>
      <span>Create your first one to start handing out translator codes.</span>`;
    $eventGrid.appendChild(empty);
  } else {
    for (const e of events) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "event-card";
      const langChips = e.languages
        .map((c) => languages.find((l) => l.code === c))
        .filter((l): l is Language => Boolean(l))
        .map((l) => `<span title="${escapeHtml(l.name)}">${l.flag}</span>`)
        .join("");
      const codeCount = codeCounts.get(e.id) ?? 0;
      const bgChip = e.backgroundExt
        ? `<span class="bg-pill on">Custom image</span>`
        : `<span class="bg-pill">Default image</span>`;
      const created = new Date(e.createdAt).toLocaleDateString();

      const isInactive = e.active === false;
      if (isInactive) card.classList.add("inactive");
      const inactiveBadge = isInactive
        ? `<span class="inactive-pill">Inactive</span>`
        : "";
      card.innerHTML = `
        <div class="event-card-name">${escapeHtml(e.name)}</div>
        <div class="event-card-langs">${langChips || '<span class="muted">no languages</span>'}</div>
        <div class="event-card-meta">
          <span>${codeCount} code${codeCount === 1 ? "" : "s"}</span>
          <span>·</span>
          ${bgChip}
          <span>·</span>
          <span>created ${created}</span>
          ${inactiveBadge ? `<span>·</span>${inactiveBadge}` : ""}
        </div>`;
      card.addEventListener("click", () => openEditEventModal(e.id));
      $eventGrid.appendChild(card);
    }
  }

  // Always append "new event" tile at the end of the grid.
  const newCard = document.createElement("button");
  newCard.type = "button";
  newCard.className = "event-card new";
  newCard.innerHTML = `<span class="plus">＋</span><span>New event</span>`;
  newCard.addEventListener("click", openNewEventModal);
  $eventGrid.appendChild(newCard);
}

// ---- New event modal -------------------------------------------------------

function openNewEventModal() {
  $eventNameInput.value = "";
  renderLangPicker($eventLanguagesPicker, new Set());
  openModalEl($newModal);
  setTimeout(() => $eventNameInput.focus(), 0);
}

function closeNewEventModal() {
  closeModalEl($newModal);
}

bindBackdropClose($newModal, closeNewEventModal);
$newModalClose.addEventListener("click", closeNewEventModal);
$newModalCancel.addEventListener("click", closeNewEventModal);

$eventForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $eventNameInput.value.trim();
  if (!name) {
    toast("Event name is required.", "error");
    $eventNameInput.focus();
    return;
  }
  const langs = selectedFromPicker($eventLanguagesPicker);
  setButtonLoading($modalSubmit, true);
  try {
    const res = await authedFetch("/api/admin/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, languages: langs }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Could not create event (HTTP ${res.status})`, "error");
      return;
    }
    const created = (await res.json()) as EventEntry;
    toast(`Event "${created.name}" created.`, "success");
    closeNewEventModal();
    await refreshAll();
  } finally {
    setButtonLoading($modalSubmit, false);
  }
});

// ---- Edit event modal ------------------------------------------------------

function currentEditEvent(): EventEntry | null {
  if (!openEditEventId) return null;
  return events.find((e) => e.id === openEditEventId) ?? null;
}

function openEditEventModal(id: string) {
  openEditEventId = id;
  renderEditEventModal();
  openModalEl($eventModal);
  // Keep "active now" fresh while the modal is open.
  void refreshChannelStats();
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = window.setInterval(() => void refreshChannelStats(), 10_000);
}

function closeEditEventModal() {
  openEditEventId = null;
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  closeModalEl($eventModal);
}

bindBackdropClose($eventModal, closeEditEventModal);
$eventModalClose.addEventListener("click", closeEditEventModal);

// Inline-edit setup for the heading. Runs once at startup; the heading element
// stays the same across openings of the modal, only its textContent changes.
inlineEdit({
  element: $detailName,
  onCommit: async (next) => {
    const ev = currentEditEvent();
    if (!ev || next === ev.name) return;
    const res = await authedFetch(`/api/admin/events/${ev.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: next }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Rename failed (HTTP ${res.status})`, "error");
      // Revert local UI to the saved name.
      $detailName.textContent = ev.name;
      return;
    }
    toast(`Renamed to "${next}".`, "success");
    await refreshAll();
  },
});

function renderEditEventModal() {
  const ev = currentEditEvent();
  if (!ev) return;
  $detailName.textContent = ev.name;
  const codeCount = codeCounts.get(ev.id) ?? 0;
  $detailMeta.textContent = `${ev.languages.length} language${
    ev.languages.length === 1 ? "" : "s"
  } · ${codeCount} code${codeCount === 1 ? "" : "s"} · created ${new Date(
    ev.createdAt,
  ).toLocaleDateString()} · click name to rename`;
  renderLangPicker($detailLanguages, new Set(ev.languages));
  renderLangPicker($detailAiLanguages, new Set(ev.aiLanguages ?? []));
  renderAiSourceOptions(ev);
  applyExclusion();
  refreshDetailBackground();
  renderCodeLanguageOptions(ev);
  resetCodeAdd();
  void refreshCodes();

  const isActive = ev.active !== false;
  $detailStatusLabel.textContent = isActive ? "Event is active" : "Event is inactive";
  $detailToggleActive.querySelector("span")!.textContent = isActive ? "Deactivate" : "Activate";
  $detailStatusZone.classList.toggle("is-inactive", !isActive);
}

function refreshDetailBackground() {
  const ev = currentEditEvent();
  if (!ev) return;
  $detailBgPreview.style.backgroundImage = `url("/api/events/${ev.id}/background?t=${Date.now()}")`;
}

function renderCodeLanguageOptions(ev: EventEntry) {
  $codeLanguage.innerHTML = "";
  const opts = languages.filter((l) => ev.languages.includes(l.code));
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

async function refreshCodes() {
  const ev = currentEditEvent();
  if (!ev) return;
  const res = await authedFetch(
    `/api/admin/codes?eventId=${encodeURIComponent(ev.id)}`,
  );
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Failed to load codes (HTTP ${res.status})`, "error");
    return;
  }
  const data = (await res.json()) as { codes: CodeEntry[] };
  renderCodes(data.codes);
}

function renderCodes(codes: CodeEntry[]) {
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
      : `<span class="code-lang">${lang?.flag ?? "🏳️"} ${escapeHtml(
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

// ---- Channel statistics ----------------------------------------------------

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
  const ev = currentEditEvent();
  if (!ev) return;
  const res = await authedFetch(
    `/api/admin/events/${encodeURIComponent(ev.id)}/stats`,
  );
  if (res.status === 401) return signOut();
  if (!res.ok) {
    $detailStats.innerHTML = `<div class="empty">Statistics unavailable (HTTP ${res.status}).</div>`;
    return;
  }
  // Guard against a late response after the modal moved to another event.
  if (currentEditEvent()?.id !== ev.id) return;
  const data = (await res.json()) as {
    channels: ChannelStat[];
    history: HistoryPoint[];
  };
  renderChannelStats(data.channels);
  renderHistoryChart(data.history ?? []);
}

// ---- Concurrent-listener history chart -------------------------------------

const HISTORY_BUCKET_MS = 5 * 60 * 1000;
const HISTORY_WINDOW_MS = 24 * 60 * 60 * 1000;

// Draw a small SVG line chart of peak concurrent listeners over the last 24 h.
// The backend series only has buckets for times it was polling, so we fill the
// full window at 5-minute steps (missing buckets = 0) for a continuous line.
// Hovering reveals the exact listener count and time at the nearest bucket.
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
    // Nothing worth charting yet — keep the panel uncluttered.
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

  // Hover read-out: map the cursor's x to the nearest 5-minute bucket and show
  // that bucket's exact listener count and timestamp.
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
    // Clamp the tooltip so it never spills past the chart edges.
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
    const label = `${lang?.flag ?? "🏳️"} ${escapeHtml(
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
  await refreshAll();
}

$detailSaveLangs.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const langs = selectedFromPicker($detailLanguages);
  const aiLangs = selectedFromPicker($detailAiLanguages);
  const aiSource = $detailAiSource.value || null;
  setButtonLoading($detailSaveLangs, true);
  try {
    const res = await authedFetch(`/api/admin/events/${ev.id}`, {
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
      toast(
        (body as { error?: string }).error ?? `Save failed (HTTP ${res.status})`,
        "error",
      );
      return;
    }
    toast("Languages saved.", "success");
    await refreshAll();
  } finally {
    setButtonLoading($detailSaveLangs, false);
  }
});

$detailBgFile.addEventListener("change", () => {
  const f = $detailBgFile.files?.[0];
  $detailBgFilename.textContent = f?.name ?? "No file chosen";
});

$detailBgForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ev = currentEditEvent();
  if (!ev) return;
  const f = $detailBgFile.files?.[0];
  if (!f) {
    toast("Pick an image first.", "error");
    return;
  }
  const fd = new FormData();
  fd.append("file", f);
  const res = await authedFetch(`/api/admin/events/${ev.id}/background`, {
    method: "POST",
    body: fd,
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast(
      (body as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`,
      "error",
    );
    return;
  }
  toast("Event background updated.", "success");
  $detailBgFile.value = "";
  $detailBgFilename.textContent = "No file chosen";
  refreshDetailBackground();
  await refreshAll();
});

$detailBgReset.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const ok = await confirmDialog({
    title: "Use default background?",
    message: "This event will fall back to the default image.",
    confirmLabel: "Use default",
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/events/${ev.id}/background`, {
    method: "DELETE",
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  toast("Event background cleared.", "success");
  refreshDetailBackground();
  await refreshAll();
});

$detailToggleActive.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const isActive = ev.active !== false;
  const res = await authedFetch(`/api/admin/events/${ev.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: !isActive }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Update failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(isActive ? `"${ev.name}" set to inactive.` : `"${ev.name}" is active again.`, "success");
  await refreshAll();
});

$detailDelete.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const ok = await confirmDialog({
    title: `Delete "${ev.name}"?`,
    message:
      "Removes the event and every translator code attached to it. This cannot be undone.",
    confirmLabel: "Delete event",
    danger: true,
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/events/${ev.id}`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Delete failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(`Event "${ev.name}" deleted.`, "success");
  closeEditEventModal();
  await refreshAll();
});

// ---- "Add code" dropdown ---------------------------------------------------
// Collapses the two generators behind one ＋ button so the panel stays tidy.

function closeCodeAddMenu() {
  $codeAddMenu.hidden = true;
  $codeAddBtn.setAttribute("aria-expanded", "false");
}

// Reset to the collapsed state: both forms hidden, menu closed.
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

// Close the menu on any outside click.
document.addEventListener("click", (e) => {
  if (!$codeAddMenu.hidden && !$codeAddMenu.contains(e.target as Node)) {
    closeCodeAddMenu();
  }
});

$codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ev = currentEditEvent();
  if (!ev) return;
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
      body: JSON.stringify({ eventId: ev.id, language, name }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      toast(`Could not generate code (HTTP ${res.status})`, "error");
      return;
    }
    const created = (await res.json()) as CodeEntry;
    toast(`Code ${created.code} created for ${created.name}.`, "success");
    $codeName.value = "";
    await refreshAll();
  } finally {
    setButtonLoading($codeSubmit, false);
  }
});

$aiCodeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ev = currentEditEvent();
  if (!ev) return;
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
      body: JSON.stringify({ eventId: ev.id, name, role: "ai-operator" }),
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
    await refreshAll();
  } finally {
    setButtonLoading($aiCodeSubmit, false);
  }
});

// ---- Languages modal -------------------------------------------------------

function openLanguagesModal() {
  $addLangCode.value = "";
  $addLangFlag.value = "";
  $addLangName.value = "";
  renderLanguageList();
  openModalEl($langModal);
  setTimeout(() => $addLangCode.focus(), 0);
}

function closeLanguagesModal() {
  closeModalEl($langModal);
}

bindBackdropClose($langModal, closeLanguagesModal);
$openLanguages.addEventListener("click", openLanguagesModal);
$langModalClose.addEventListener("click", closeLanguagesModal);

// Debounced auto-save for language rows.
const langSaveTimers = new Map<string, number>();
function scheduleLanguageSave(
  code: string,
  flagInput: HTMLInputElement,
  nameInput: HTMLInputElement,
  marker: HTMLSpanElement,
) {
  const existing = langSaveTimers.get(code);
  if (existing) clearTimeout(existing);
  const t = window.setTimeout(
    () => void saveLanguage(code, nameInput.value, flagInput.value, marker),
    500,
  );
  langSaveTimers.set(code, t);
}

function renderLanguageList() {
  $langList.innerHTML = "";
  if (languages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No languages configured yet — add one above.";
    $langList.appendChild(empty);
    return;
  }
  const header = document.createElement("div");
  header.className = "lang-table-header";
  header.innerHTML = `<span>Code</span><span>Flag</span><span>Name</span><span></span>`;
  $langList.appendChild(header);
  for (const l of languages) {
    const row = document.createElement("div");
    row.className = "lang-row";
    row.innerHTML = `
      <span class="lang-row-code">${escapeHtml(l.code)}</span>
      <input class="lang-row-flag" type="text" maxlength="6" value="${escapeHtml(l.flag)}" aria-label="Flag" />
      <input class="lang-row-name" type="text" value="${escapeHtml(l.name)}" aria-label="Display name" />
      <div class="lang-row-actions">
        <span class="saved-mark">✓</span>
        <button type="button" class="danger outline small lang-row-remove"><span>Remove</span></button>
      </div>`;
    const flagInput = row.querySelector<HTMLInputElement>(".lang-row-flag")!;
    const nameInput = row.querySelector<HTMLInputElement>(".lang-row-name")!;
    const marker = row.querySelector<HTMLSpanElement>(".saved-mark")!;
    const removeBtn = row.querySelector<HTMLButtonElement>(".lang-row-remove")!;

    flagInput.addEventListener("input", () =>
      scheduleLanguageSave(l.code, flagInput, nameInput, marker),
    );
    nameInput.addEventListener("input", () =>
      scheduleLanguageSave(l.code, flagInput, nameInput, marker),
    );
    removeBtn.addEventListener("click", () => removeLanguage(l.code, l.name));
    $langList.appendChild(row);
  }
}

async function saveLanguage(
  code: string,
  name: string,
  flag: string,
  marker?: HTMLSpanElement,
) {
  if (!name.trim()) return; // Skip empty saves.
  const res = await authedFetch(`/api/admin/languages/${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, flag }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast((body as { error?: string }).error ?? `Save failed (HTTP ${res.status})`, "error");
    return;
  }
  if (marker) {
    marker.classList.add("visible");
    setTimeout(() => marker.classList.remove("visible"), 1500);
  }
  await loadLanguages();
  // Re-render the event grid so flags stay consistent, but don't re-render the
  // languages modal list (would steal focus from whatever input is being edited).
  renderEventGrid();
}

async function removeLanguage(code: string, name: string) {
  const ok = await confirmDialog({
    title: `Remove "${name}"?`,
    message:
      "It will be stripped from every event and any codes for it will be revoked.",
    confirmLabel: "Remove language",
    danger: true,
  });
  if (!ok) return;
  const res = await authedFetch(`/api/admin/languages/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    toast(`Remove failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(`Language "${name}" removed.`, "success");
  await refreshAll();
  renderLanguageList();
}

$addLangForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $addLangCode.value.trim().toLowerCase();
  const name = $addLangName.value.trim();
  const flag = $addLangFlag.value.trim();
  if (!code || !name) {
    toast("Code and name are required.", "error");
    return;
  }
  const res = await authedFetch("/api/admin/languages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name, flag: flag || undefined }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    toast((body as { error?: string }).error ?? `Add failed (HTTP ${res.status})`, "error");
    return;
  }
  toast(`Language "${name}" added.`, "success");
  $addLangCode.value = "";
  $addLangFlag.value = "";
  $addLangName.value = "";
  await refreshAll();
  renderLanguageList();
});

// ---- AI settings modal -----------------------------------------------------

let aiModelsLoaded = false;

function closeAiSettings() {
  closeModalEl($aiModal);
}

bindBackdropClose($aiModal, closeAiSettings);
$openAiSettings.addEventListener("click", () => void openAiSettings());
$aiModalClose.addEventListener("click", closeAiSettings);

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
    aiModelsLoaded = true;
  } finally {
    setButtonLoading($aiRefreshModels, false);
  }
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

async function openAiSettings() {
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
  $aiKey.placeholder = cfg.hasKey
    ? `Saved (${cfg.openRouterApiKey}) — leave blank to keep`
    : "sk-or-…";
  $aiTemp.value = String(cfg.temperature ?? 0.3);
  openModalEl($aiModal);
  if (!aiModelsLoaded) {
    await loadAiModels(cfg.model);
  } else {
    ensureModelOption(cfg.model);
  }
}

$aiRefreshModels.addEventListener("click", () => void loadAiModels());

$aiForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const payload: Record<string, unknown> = {
    model: $aiModel.value,
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
    closeAiSettings();
  } finally {
    setButtonLoading($aiSubmit, false);
  }
});

// ---- Default background ----------------------------------------------------

$logoutBtn.addEventListener("click", signOut);

async function refreshGlobalBackgroundPreview() {
  $bgPreview.style.backgroundImage = `url("/api/background?t=${Date.now()}")`;
}

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
  await refreshGlobalBackgroundPreview();
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
  await refreshGlobalBackgroundPreview();
});

// ---- QR codes -------------------------------------------------------------

(function renderQrCodes() {
  const listenerUrl   = window.location.origin + "/";
  const translatorUrl = window.location.origin + "/translator-login.html";

  $qrListenerUrl.textContent   = listenerUrl;
  $qrTranslatorUrl.textContent = translatorUrl;

  const qrOpts: QRCode.QRCodeRenderersOptions = {
    width: 192,
    margin: 1,
    color: { dark: "#0f172a", light: "#ffffff" },
  };
  void QRCode.toCanvas($qrListener,   listenerUrl,   qrOpts);
  void QRCode.toCanvas($qrTranslator, translatorUrl, qrOpts);

  $copyListener.addEventListener("click", () => {
    void navigator.clipboard.writeText(listenerUrl)
      .then(() => toast("Listener URL copied.", "success"));
  });
  $copyTranslator.addEventListener("click", () => {
    void navigator.clipboard.writeText(translatorUrl)
      .then(() => toast("Translator URL copied.", "success"));
  });
})();

// ---- Connection poster ----------------------------------------------------

(function setupPoster() {
  const STORAGE_KEY = "every-ear:wifi";
  const EYE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function syncAuthUi(): void {
    $wifiPasswordLabel.hidden = $wifiAuth.value === "nopass";
  }

  // Restore previously entered Wi-Fi from this browser.
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      ssid?: string;
      auth?: WifiAuth;
      password?: string;
      hidden?: boolean;
    } | null;
    if (saved) {
      $wifiSsid.value = saved.ssid ?? "";
      $wifiAuth.value = saved.auth ?? "WPA";
      $wifiPassword.value = saved.password ?? "";
      $wifiHidden.checked = !!saved.hidden;
    }
  } catch {
    /* ignore malformed storage */
  }

  $wifiPasswordToggle.innerHTML = EYE;
  syncAuthUi();
  $wifiAuth.addEventListener("change", syncAuthUi);

  $wifiPasswordToggle.addEventListener("click", () => {
    const reveal = $wifiPassword.type === "password";
    $wifiPassword.type = reveal ? "text" : "password";
    $wifiPasswordToggle.innerHTML = reveal ? EYE_OFF : EYE;
    $wifiPasswordToggle.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
  });

  // Which poster is currently shown — drives the download filename.
  let currentTarget: "listener" | "translator" = "listener";

  function slug(): string {
    const net = ($wifiSsid.value.trim() || "every-ear")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return `${currentTarget}-${net}`;
  }

  // The two posters differ only in the second QR column: the listener page or
  // the translator login. The Wi-Fi column and headline are shared.
  const TARGETS = {
    listener: {
      url: window.location.origin + "/",
      heading: "Listen live",
      instruction: "Scan, pick your language, press play.",
      button: $posterListener,
    },
    translator: {
      url: window.location.origin + "/translator-login.html",
      heading: "Translator login",
      instruction: "Scan to log in and broadcast a language.",
      button: $posterTranslator,
    },
  } as const;

  async function showPoster(which: "listener" | "translator"): Promise<void> {
    const ssid = $wifiSsid.value.trim();
    const auth = $wifiAuth.value as WifiAuth;
    const password = $wifiPassword.value;
    const hidden = $wifiHidden.checked;

    if (!ssid) {
      toast("Enter the Wi-Fi network name first.", "error");
      $wifiSsid.focus();
      return;
    }
    if (auth !== "nopass" && !password) {
      toast("Enter the Wi-Fi password, or choose “Open — no password”.", "error");
      return;
    }

    const t = TARGETS[which];
    currentTarget = which;
    setButtonLoading(t.button, true);
    $posterStatus.textContent = "Generating…";
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ ssid, auth, password: auth === "nopass" ? "" : password, hidden }),
      );
      await renderPoster($posterCanvas, {
        title: "Live Translation",
        target: { url: t.url, heading: t.heading, instruction: t.instruction },
        wifi: { ssid, password, auth, hidden },
      });
      $posterPreview.hidden = false;
      $posterActions.hidden = false;
      $posterStatus.textContent = "";
      $posterPreview.scrollIntoView({ behavior: "smooth", block: "nearest" });
      toast("Poster ready.", "success");
    } catch (err) {
      $posterStatus.textContent = "";
      toast(err instanceof Error ? err.message : "Could not generate the poster.", "error");
    } finally {
      setButtonLoading(t.button, false);
    }
  }

  $posterListener.addEventListener("click", () => void showPoster("listener"));
  $posterTranslator.addEventListener("click", () => void showPoster("translator"));

  $downloadPoster.addEventListener("click", () => {
    $posterCanvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `every-ear-poster-${slug()}.png`;
      a.click();
      URL.revokeObjectURL(url);
    }, "image/png");
  });

  $copyPoster.addEventListener("click", async () => {
    try {
      const blob = await new Promise<Blob | null>((res) =>
        $posterCanvas.toBlob(res, "image/png"),
      );
      if (!blob) throw new Error("no image");
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("Poster copied to clipboard.", "success");
    } catch {
      toast("Copy isn't supported here — use Download instead.", "error");
    }
  });
})();

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await refreshAll();
  await refreshGlobalBackgroundPreview();
})();
