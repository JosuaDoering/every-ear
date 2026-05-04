import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

const $logoutBtn = document.getElementById("admin-logout") as HTMLButtonElement;
const $openLanguages = document.getElementById("open-languages") as HTMLButtonElement;

const $eventTableBody = document.getElementById("event-table-body") as HTMLDivElement;
const $openNewEvent = document.getElementById("open-new-event") as HTMLButtonElement;

// New-event modal.
const $newModal = document.getElementById("modal-backdrop") as HTMLDivElement;
const $newModalClose = document.getElementById("modal-close") as HTMLButtonElement;
const $newModalCancel = document.getElementById("modal-cancel") as HTMLButtonElement;
const $eventForm = document.getElementById("event-form") as HTMLFormElement;
const $eventName = document.getElementById("event-name") as HTMLInputElement;
const $eventLanguages = document.getElementById("event-languages") as HTMLDivElement;

// Edit-event modal.
const $eventModal = document.getElementById("event-modal-backdrop") as HTMLDivElement;
const $eventModalClose = document.getElementById("event-modal-close") as HTMLButtonElement;
const $detailName = document.getElementById("detail-name") as HTMLHeadingElement;
const $detailMeta = document.getElementById("detail-meta") as HTMLParagraphElement;
const $detailRename = document.getElementById("detail-rename") as HTMLButtonElement;
const $detailLanguages = document.getElementById("detail-languages") as HTMLDivElement;
const $detailSaveLangs = document.getElementById("detail-save-langs") as HTMLButtonElement;
const $detailBgPreview = document.getElementById("detail-bg-preview") as HTMLDivElement;
const $detailBgForm = document.getElementById("detail-bg-form") as HTMLFormElement;
const $detailBgFile = document.getElementById("detail-bg-file") as HTMLInputElement;
const $detailBgFilename = document.getElementById("detail-bg-filename") as HTMLSpanElement;
const $detailBgReset = document.getElementById("detail-bg-reset") as HTMLButtonElement;
const $detailDelete = document.getElementById("detail-delete") as HTMLButtonElement;

const $codeLanguage = document.getElementById("code-language") as HTMLSelectElement;
const $codeName = document.getElementById("code-name") as HTMLInputElement;
const $codeForm = document.getElementById("code-form") as HTMLFormElement;
const $codeList = document.getElementById("code-list") as HTMLDivElement;

// Languages modal.
const $langModal = document.getElementById("lang-modal-backdrop") as HTMLDivElement;
const $langModalClose = document.getElementById("lang-modal-close") as HTMLButtonElement;
const $langList = document.getElementById("lang-list") as HTMLDivElement;
const $addLangForm = document.getElementById("add-lang-form") as HTMLFormElement;
const $addLangCode = document.getElementById("add-lang-code") as HTMLInputElement;
const $addLangFlag = document.getElementById("add-lang-flag") as HTMLInputElement;
const $addLangName = document.getElementById("add-lang-name") as HTMLInputElement;

// Default-background block.
const $bgForm = document.getElementById("bg-form") as HTMLFormElement;
const $bgFile = document.getElementById("bg-file") as HTMLInputElement;
const $bgFilename = document.getElementById("bg-filename") as HTMLSpanElement;
const $bgPreview = document.getElementById("bg-preview") as HTMLDivElement;
const $bgReset = document.getElementById("bg-reset") as HTMLButtonElement;

const $status = document.getElementById("status") as HTMLDivElement;

type EventEntry = {
  id: string;
  name: string;
  languages: string[];
  backgroundExt?: string;
  createdAt: string;
};

type CodeEntry = {
  code: string;
  eventId: string;
  language: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
};

let languages: Language[] = [];
let events: EventEntry[] = [];
let codeCounts = new Map<string, number>();
let openEditEventId: string | null = null;

function setStatus(text: string, kind: "info" | "error" | "ok" = "info") {
  $status.textContent = text;
  $status.classList.remove("error", "ok");
  if (kind === "error") $status.classList.add("error");
  else if (kind === "ok") $status.classList.add("ok");
}

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
    const id = `${target.id}-${l.code}`;
    const wrap = document.createElement("label");
    wrap.className = "lang-chip";
    wrap.innerHTML = `<input type="checkbox" id="${id}" value="${l.code}" ${
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
    setStatus(`Failed to load codes (HTTP ${res.status})`, "error");
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
    setStatus(`Failed to load events (HTTP ${eventsRes.status})`, "error");
    return;
  }
  const data = (await eventsRes.json()) as { events: EventEntry[] };
  events = data.events;
  codeCounts = new Map();
  for (const c of allCodes) {
    codeCounts.set(c.eventId, (codeCounts.get(c.eventId) ?? 0) + 1);
  }
  renderEventTable();
  if (openEditEventId) {
    const stillExists = events.some((e) => e.id === openEditEventId);
    if (!stillExists) {
      closeEditEventModal();
    } else {
      renderEditEventModal();
    }
  }
}

// ---- Event table -----------------------------------------------------------

function renderEventTable() {
  $eventTableBody.innerHTML = "";
  if (events.length === 0) {
    const empty = document.createElement("div");
    empty.className = "event-table-empty";
    empty.textContent = "No events yet — use “＋ New event” to create one.";
    $eventTableBody.appendChild(empty);
    return;
  }
  for (const e of events) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "event-table-row";
    const langChips = e.languages
      .map((c) => languages.find((l) => l.code === c))
      .filter((l): l is Language => Boolean(l))
      .map(
        (l) =>
          `<span class="event-lang-chip" title="${escapeHtml(l.name)}">${l.flag}</span>`,
      )
      .join("");
    const langCell = langChips || '<span class="muted">none</span>';
    const codeCount = codeCounts.get(e.id) ?? 0;
    const bgCell = e.backgroundExt
      ? `<span class="bg-pill on">Custom</span>`
      : `<span class="bg-pill">Default</span>`;

    row.innerHTML = `
      <div class="cell-name">${escapeHtml(e.name)}</div>
      <div class="cell-langs">${langCell}</div>
      <div class="cell-num">${codeCount}</div>
      <div class="cell-bg">${bgCell}</div>
      <div class="cell-chevron" aria-hidden="true">›</div>`;
    row.addEventListener("click", () => openEditEventModal(e.id));
    $eventTableBody.appendChild(row);
  }
}

// ---- New event modal -------------------------------------------------------

function openNewEventModal() {
  $eventName.value = "";
  renderLangPicker($eventLanguages, new Set());
  openModalEl($newModal);
  setTimeout(() => $eventName.focus(), 0);
}

function closeNewEventModal() {
  closeModalEl($newModal);
}

bindBackdropClose($newModal, closeNewEventModal);
$openNewEvent.addEventListener("click", openNewEventModal);
$newModalClose.addEventListener("click", closeNewEventModal);
$newModalCancel.addEventListener("click", closeNewEventModal);

$eventForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $eventName.value.trim();
  if (!name) {
    setStatus("Event name is required.", "error");
    return;
  }
  const langs = selectedFromPicker($eventLanguages);
  const res = await authedFetch("/api/admin/events", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, languages: langs }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Could not create event (HTTP ${res.status})`, "error");
    return;
  }
  const created = (await res.json()) as EventEntry;
  setStatus(`Event "${created.name}" created.`, "ok");
  closeNewEventModal();
  await refreshAll();
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
}

function closeEditEventModal() {
  openEditEventId = null;
  closeModalEl($eventModal);
}

bindBackdropClose($eventModal, closeEditEventModal);
$eventModalClose.addEventListener("click", closeEditEventModal);

function renderEditEventModal() {
  const ev = currentEditEvent();
  if (!ev) return;
  $detailName.textContent = ev.name;
  const codeCount = codeCounts.get(ev.id) ?? 0;
  $detailMeta.textContent = `${ev.languages.length} languages · ${codeCount} codes · created ${new Date(
    ev.createdAt,
  ).toLocaleDateString()}`;
  renderLangPicker($detailLanguages, new Set(ev.languages));
  refreshDetailBackground();
  renderCodeLanguageOptions(ev);
  void refreshCodes();
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
    setStatus(`Failed to load codes (HTTP ${res.status})`, "error");
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
    const lang = languages.find((l) => l.code === c.language);
    const row = document.createElement("div");
    row.className = "code-row";

    const codeEl = document.createElement("div");
    codeEl.className = "code-value";
    codeEl.textContent = c.code;

    const meta = document.createElement("div");
    meta.className = "code-meta";
    const flag = lang?.flag ?? "🏳️";
    const langName = lang?.name ?? c.language.toUpperCase();
    meta.innerHTML = `<strong>${escapeHtml(c.name)}</strong>
      <span class="code-lang">${flag} ${escapeHtml(langName)}</span>
      <span class="code-time">${formatRelative(
        c.lastUsedAt ?? c.createdAt,
        c.lastUsedAt ? "used" : "created",
      )}</span>`;

    const revoke = document.createElement("button");
    revoke.className = "danger small";
    revoke.innerHTML = "<span>Revoke</span>";
    revoke.addEventListener("click", () => revokeCode(c.code));

    row.appendChild(codeEl);
    row.appendChild(meta);
    row.appendChild(revoke);
    $codeList.appendChild(row);
  }
}

async function revokeCode(code: string) {
  if (!confirm(`Revoke code ${code}? Translator using it will be locked out.`)) return;
  const res = await authedFetch(`/api/admin/codes/${code}`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Revoke failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Code ${code} revoked.`, "ok");
  await refreshAll();
}

$detailRename.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const next = prompt("Event name:", ev.name)?.trim();
  if (!next || next === ev.name) return;
  const res = await authedFetch(`/api/admin/events/${ev.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: next }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Rename failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Renamed to "${next}".`, "ok");
  await refreshAll();
});

$detailSaveLangs.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  const langs = selectedFromPicker($detailLanguages);
  const res = await authedFetch(`/api/admin/events/${ev.id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ languages: langs }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Save failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus("Languages saved.", "ok");
  await refreshAll();
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
    setStatus("Pick an image first.", "error");
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
    setStatus((body as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus("Event background updated.", "ok");
  $detailBgFile.value = "";
  $detailBgFilename.textContent = "No file chosen";
  refreshDetailBackground();
  await refreshAll();
});

$detailBgReset.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  if (!confirm("Use the default background for this event?")) return;
  const res = await authedFetch(`/api/admin/events/${ev.id}/background`, {
    method: "DELETE",
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus("Event background cleared.", "ok");
  refreshDetailBackground();
  await refreshAll();
});

$detailDelete.addEventListener("click", async () => {
  const ev = currentEditEvent();
  if (!ev) return;
  if (!confirm(`Delete event "${ev.name}" and all its codes? This cannot be undone.`)) return;
  const res = await authedFetch(`/api/admin/events/${ev.id}`, { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Delete failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Event "${ev.name}" deleted.`, "ok");
  closeEditEventModal();
  await refreshAll();
});

$codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ev = currentEditEvent();
  if (!ev) return;
  const language = $codeLanguage.value;
  const name = $codeName.value.trim();
  if (!language) {
    setStatus("Pick a language for the code.", "error");
    return;
  }
  if (!name) {
    setStatus("Translator name is required.", "error");
    return;
  }
  const res = await authedFetch("/api/admin/codes", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ eventId: ev.id, language, name }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Could not generate code (HTTP ${res.status})`, "error");
    return;
  }
  const created = (await res.json()) as CodeEntry;
  setStatus(`Code ${created.code} created for ${created.name}.`, "ok");
  $codeName.value = "";
  await refreshAll();
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

function renderLanguageList() {
  $langList.innerHTML = "";
  if (languages.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No languages configured yet.";
    $langList.appendChild(empty);
    return;
  }
  for (const l of languages) {
    const row = document.createElement("div");
    row.className = "lang-row";
    row.innerHTML = `
      <span class="lang-row-code">${escapeHtml(l.code)}</span>
      <input class="lang-row-flag" type="text" maxlength="6" value="${escapeHtml(l.flag)}" />
      <input class="lang-row-name" type="text" value="${escapeHtml(l.name)}" />
      <button type="button" class="ghost small lang-row-save"><span>Save</span></button>
      <button type="button" class="danger small lang-row-remove"><span>Remove</span></button>`;
    const flagInput = row.querySelector<HTMLInputElement>(".lang-row-flag")!;
    const nameInput = row.querySelector<HTMLInputElement>(".lang-row-name")!;
    const saveBtn = row.querySelector<HTMLButtonElement>(".lang-row-save")!;
    const removeBtn = row.querySelector<HTMLButtonElement>(".lang-row-remove")!;

    saveBtn.addEventListener("click", () =>
      saveLanguage(l.code, nameInput.value, flagInput.value),
    );
    removeBtn.addEventListener("click", () => removeLanguage(l.code, l.name));
    $langList.appendChild(row);
  }
}

async function saveLanguage(code: string, name: string, flag: string) {
  const res = await authedFetch(`/api/admin/languages/${encodeURIComponent(code)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, flag }),
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    setStatus((body as { error?: string }).error ?? `Save failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Language "${code}" saved.`, "ok");
  await refreshAll();
  renderLanguageList();
}

async function removeLanguage(code: string, name: string) {
  if (
    !confirm(
      `Remove language "${name}"? It will be stripped from every event and any codes for it will be revoked.`,
    )
  )
    return;
  const res = await authedFetch(`/api/admin/languages/${encodeURIComponent(code)}`, {
    method: "DELETE",
  });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Remove failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Language "${name}" removed.`, "ok");
  await refreshAll();
  renderLanguageList();
}

$addLangForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const code = $addLangCode.value.trim().toLowerCase();
  const name = $addLangName.value.trim();
  const flag = $addLangFlag.value.trim();
  if (!code || !name) {
    setStatus("Code and name are required.", "error");
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
    setStatus((body as { error?: string }).error ?? `Add failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus(`Language "${name}" added.`, "ok");
  $addLangCode.value = "";
  $addLangFlag.value = "";
  $addLangName.value = "";
  await refreshAll();
  renderLanguageList();
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
    setStatus("Pick an image first.", "error");
    return;
  }
  const fd = new FormData();
  fd.append("file", f);
  const res = await authedFetch("/api/admin/background", { method: "POST", body: fd });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    setStatus((body as { error?: string }).error ?? `Upload failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus("Default background updated.", "ok");
  $bgFile.value = "";
  $bgFilename.textContent = "No file chosen";
  await refreshGlobalBackgroundPreview();
});

$bgReset.addEventListener("click", async () => {
  if (!confirm("Reset default background to the bundled image?")) return;
  const res = await authedFetch("/api/admin/background", { method: "DELETE" });
  if (res.status === 401) return signOut();
  if (!res.ok) {
    setStatus(`Reset failed (HTTP ${res.status})`, "error");
    return;
  }
  setStatus("Default background reset.", "ok");
  await refreshGlobalBackgroundPreview();
});

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await refreshAll();
  await refreshGlobalBackgroundPreview();
})();
