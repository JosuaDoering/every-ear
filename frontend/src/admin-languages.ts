// Language catalog: the pool of languages available when creating events.

import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";
import { toast, confirmDialog } from "./ui.js";
import { renderAdminNav } from "./admin-nav.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

renderAdminNav(
  "languages",
  "Languages",
  "Catalog of languages available when creating events. Per-event selection happens in the event.",
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}

const $langList = document.getElementById("lang-list") as HTMLDivElement;
const $addLangForm = document.getElementById("add-lang-form") as HTMLFormElement;
const $addLangCode = document.getElementById("add-lang-code") as HTMLInputElement;
const $addLangFlag = document.getElementById("add-lang-flag") as HTMLInputElement;
const $addLangName = document.getElementById("add-lang-name") as HTMLInputElement;

let languages: Language[] = [];

async function loadLanguages() {
  languages = await fetchLanguages();
}

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
  // Reload without re-rendering (would steal focus from the input being edited).
  await loadLanguages();
}

async function removeLanguage(code: string, name: string) {
  const ok = await confirmDialog({
    title: `Remove "${name}"?`,
    message: "It will be stripped from every event and any codes for it will be revoked.",
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
  await loadLanguages();
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
  await loadLanguages();
  renderLanguageList();
});

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await loadLanguages();
  renderLanguageList();
})();
