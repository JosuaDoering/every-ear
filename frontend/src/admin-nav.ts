// Shared admin header + top tabs. Injected into <div id="admin-nav"> so every
// admin page looks and behaves the same and there is a single place to edit.

import { clearAdminToken } from "./session.js";

export type AdminTab = "events" | "languages" | "ai" | "settings";

const TABS: { id: AdminTab; label: string; href: string }[] = [
  { id: "events", label: "Events", href: "/admin.html" },
  { id: "languages", label: "Languages", href: "/admin-languages.html" },
  { id: "ai", label: "AI translation", href: "/admin-ai.html" },
  { id: "settings", label: "Settings", href: "/admin-settings.html" },
];

/** Render the shared header + tab bar. `title` must be static text. */
export function renderAdminNav(active: AdminTab, title: string, subtitle?: string): void {
  const host = document.getElementById("admin-nav");
  if (!host) return;

  const links = TABS.map(
    (t) =>
      `<a class="admin-tab${t.id === active ? " active" : ""}" href="${t.href}"${
        t.id === active ? ' aria-current="page"' : ""
      }>${t.label}</a>`,
  ).join("");

  host.innerHTML = `
    <header class="admin-header">
      <div class="admin-header-text">
        <h1>${title}</h1>
        ${subtitle ? `<p class="hint">${subtitle}</p>` : ""}
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
