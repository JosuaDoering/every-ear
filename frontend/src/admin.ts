// Events page: access links/QR, Wi-Fi poster and the event grid. Each event
// opens its own detail page; languages and AI provider live on their own pages.

import QRCode from "qrcode";
import { renderPoster, type WifiAuth } from "./poster.js";
import { fetchLanguages, type Language } from "./livekit.js";
import { loadAdminToken, clearAdminToken } from "./session.js";
import { toast, setButtonLoading } from "./ui.js";
import { renderAdminNav } from "./admin-nav.js";

const token = loadAdminToken();
if (!token) {
  location.replace("/admin-login.html");
  throw new Error("not authenticated");
}

renderAdminNav("events", "Events", "Access links, events and translator codes.");

// ---- Refs ------------------------------------------------------------------

const $eventGrid = document.getElementById("event-grid") as HTMLDivElement;

const $newModal = document.getElementById("modal-backdrop") as HTMLDivElement;
const $newModalClose = document.getElementById("modal-close") as HTMLButtonElement;
const $newModalCancel = document.getElementById("modal-cancel") as HTMLButtonElement;
const $eventForm = document.getElementById("event-form") as HTMLFormElement;
const $eventNameInput = document.getElementById("event-name") as HTMLInputElement;
const $eventLanguagesPicker = document.getElementById("event-languages") as HTMLDivElement;
const $modalSubmit = document.getElementById("modal-submit") as HTMLButtonElement;

const $qrListener   = document.getElementById("qr-listener")     as HTMLCanvasElement;
const $qrTranslator = document.getElementById("qr-translator")   as HTMLCanvasElement;
const $qrListenerUrl   = document.getElementById("qr-listener-url")   as HTMLElement;
const $qrTranslatorUrl = document.getElementById("qr-translator-url") as HTMLElement;
const $copyListener   = document.getElementById("copy-listener")   as HTMLButtonElement;
const $copyTranslator = document.getElementById("copy-translator") as HTMLButtonElement;

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

// ---- Types + state ---------------------------------------------------------

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

type CodeEntry = { eventId: string };

let languages: Language[] = [];
let events: EventEntry[] = [];
let codeCounts = new Map<string, number>();

// ---- Helpers ---------------------------------------------------------------

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

function signOut() {
  clearAdminToken();
  location.replace("/admin-login.html");
}

// ---- Modal plumbing (new-event only) ---------------------------------------

function openModalEl(el: HTMLDivElement) {
  el.hidden = false;
}

function closeModalEl(el: HTMLDivElement) {
  el.hidden = true;
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$newModal.hidden) closeNewEventModal();
});

function bindBackdropClose(backdrop: HTMLDivElement, onClose: () => void) {
  backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) onClose();
  });
}

// ---- Language picker -------------------------------------------------------

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

// ---- Data loading ----------------------------------------------------------

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
  languages = await fetchLanguages();
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
}

// ---- Event grid ------------------------------------------------------------

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
      card.addEventListener("click", () => {
        location.href = `/admin-event.html?id=${encodeURIComponent(e.id)}`;
      });
      $eventGrid.appendChild(card);
    }
  }

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

// ---- QR codes --------------------------------------------------------------

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

// ---- Connection poster -----------------------------------------------------

(function setupPoster() {
  const STORAGE_KEY = "every-ear:wifi";
  const EYE =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF =
    '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20C5 20 1 12 1 12a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function syncAuthUi(): void {
    $wifiPasswordLabel.hidden = $wifiAuth.value === "nopass";
  }

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

  let currentTarget: "listener" | "translator" = "listener";

  function slug(): string {
    const net = ($wifiSsid.value.trim() || "every-ear")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase();
    return `${currentTarget}-${net}`;
  }

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

// ---- Init ------------------------------------------------------------------

(async () => {
  const ping = await authedFetch("/api/admin/login");
  if (!ping.ok) return signOut();
  await refreshAll();
})();
