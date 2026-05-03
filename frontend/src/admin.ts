import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

const $logoutBtn = document.getElementById("admin-logout") as HTMLButtonElement;
const $codeLanguage = document.getElementById("code-language") as HTMLSelectElement;
const $codeName = document.getElementById("code-name") as HTMLInputElement;
const $codeForm = document.getElementById("code-form") as HTMLFormElement;
const $codeList = document.getElementById("code-list") as HTMLDivElement;
const $bgForm = document.getElementById("bg-form") as HTMLFormElement;
const $bgFile = document.getElementById("bg-file") as HTMLInputElement;
const $bgFilename = document.getElementById("bg-filename") as HTMLSpanElement;
const $bgPreview = document.getElementById("bg-preview") as HTMLDivElement;
const $bgReset = document.getElementById("bg-reset") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLDivElement;

let languages: Language[] = [];

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

async function loadLanguages() {
  languages = await fetchLanguages();
  $codeLanguage.innerHTML = "";
  for (const l of languages) {
    const opt = document.createElement("option");
    opt.value = l.code;
    opt.textContent = `${l.flag}  ${l.name}`;
    $codeLanguage.appendChild(opt);
  }
}

type CodeEntry = {
  code: string;
  language: string;
  name: string;
  createdAt: string;
  lastUsedAt?: string;
};

async function refreshCodes() {
  try {
    const res = await authedFetch("/api/admin/codes");
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { codes: CodeEntry[] };
    renderCodes(data.codes);
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Failed to load codes", "error");
  }
}

function renderCodes(codes: CodeEntry[]) {
  $codeList.innerHTML = "";
  if (codes.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No codes yet — generate one below.";
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
      <span class="code-time">${formatRelative(c.lastUsedAt ?? c.createdAt, c.lastUsedAt ? "used" : "created")}</span>`;

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
  try {
    const res = await authedFetch(`/api/admin/codes/${code}`, { method: "DELETE" });
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(`Code ${code} revoked.`, "ok");
    await refreshCodes();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Revoke failed", "error");
  }
}

async function refreshBackgroundPreview() {
  $bgPreview.style.backgroundImage = `url("/api/background?t=${Date.now()}")`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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

$logoutBtn.addEventListener("click", signOut);

$codeForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const language = $codeLanguage.value;
  const name = $codeName.value.trim();
  if (!name) {
    setStatus("Name is required.", "error");
    return;
  }
  try {
    const res = await authedFetch("/api/admin/codes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ language, name }),
    });
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const created = (await res.json()) as CodeEntry;
    setStatus(`Code ${created.code} created for ${created.name}.`, "ok");
    $codeName.value = "";
    await refreshCodes();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Could not generate code", "error");
  }
});

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
  try {
    const res = await authedFetch("/api/admin/background", { method: "POST", body: fd });
    if (res.status === 401) return signOut();
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
    }
    setStatus("Background updated.", "ok");
    $bgFile.value = "";
    $bgFilename.textContent = "No file chosen";
    await refreshBackgroundPreview();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Upload failed", "error");
  }
});

$bgReset.addEventListener("click", async () => {
  if (!confirm("Reset background to the default image?")) return;
  try {
    const res = await authedFetch("/api/admin/background", { method: "DELETE" });
    if (res.status === 401) return signOut();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus("Background reset.", "ok");
    await refreshBackgroundPreview();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Reset failed", "error");
  }
});

(async () => {
  // Validate token before rendering anything sensitive.
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await Promise.all([loadLanguages(), refreshCodes(), refreshBackgroundPreview()]);
})();
