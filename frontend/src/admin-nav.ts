// Shared admin header + top tabs. Injected into <div id="admin-nav"> so every
// admin page looks and behaves the same and there is a single place to edit.

import { clearAdminToken } from "./session.js";
import { escapeHtml } from "./ui.js";

export type AdminTab = "events" | "languages" | "ai" | "settings";

const icon = (svg: string): string =>
  `<span class="admin-tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${svg}</svg></span>`;

const TABS: { id: AdminTab; label: string; href: string; icon: string }[] = [
  {
    id: "events",
    label: "Events",
    href: "/admin.html",
    icon: icon(
      '<rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line>',
    ),
  },
  {
    id: "languages",
    label: "Languages",
    href: "/admin-languages.html",
    icon: icon(
      '<circle cx="12" cy="12" r="10"></circle><line x1="2" y1="12" x2="22" y2="12"></line><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>',
    ),
  },
  {
    id: "ai",
    label: "AI translation",
    href: "/admin-ai.html",
    icon: icon(
      '<path d="M12 3l1.9 4.8L18.7 9.7l-4.8 1.9L12 16.4l-1.9-4.8L5.3 9.7l4.8-1.9L12 3z"></path><path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8L18 15z"></path>',
    ),
  },
  {
    id: "settings",
    label: "Settings",
    href: "/admin-settings.html",
    icon: icon(
      '<circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>',
    ),
  },
];

/** Render the shared header + tab bar. `title` must be static text. */
export function renderAdminNav(active: AdminTab, title: string, subtitle?: string): void {
  const host = document.getElementById("admin-nav");
  if (!host) return;

  const links = TABS.map(
    (t) =>
      `<a class="admin-tab${t.id === active ? " active" : ""}" href="${t.href}" aria-label="${t.label}"${
        t.id === active ? ' aria-current="page"' : ""
      }>${t.icon}<span class="admin-tab-label">${t.label}</span></a>`,
  ).join("");

  host.innerHTML = `
    <header class="admin-header">
      <div class="admin-header-text">
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p class="hint">${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <div class="admin-header-actions">
        <button type="button" id="admin-logout" class="ghost"><span>Sign out</span></button>
      </div>
    </header>
    <nav class="admin-tabs" aria-label="Admin sections">${links}</nav>`;

  host.querySelector<HTMLButtonElement>("#admin-logout")?.addEventListener("click", () => {
    clearAdminToken();
    location.replace("/admin-login.html");
  });
}

/** Update the page title after async data loaded (e.g. the event name). */
export function setAdminNavTitle(title: string): void {
  const h1 = document.querySelector<HTMLHeadingElement>("#admin-nav h1");
  if (h1) h1.textContent = title;
  document.title = `Every Ear · ${title}`;
}
