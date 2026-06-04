import { loadAdminToken, saveAdminToken, clearAdminToken } from "./session.js";
import { setButtonLoading } from "./ui.js";

async function pingAuth(token: string): Promise<boolean> {
  const res = await fetch("/api/admin/login", {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}

// If we already have a working token, jump straight to the dashboard.
(async () => {
  const existing = loadAdminToken();
  if (existing && (await pingAuth(existing))) {
    location.replace("/admin.html");
  } else if (existing) {
    clearAdminToken();
  }
})();

const $password = document.getElementById("admin-password") as HTMLInputElement;
const $loginBtn = document.getElementById("admin-login") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLDivElement;
const $toggle = document.getElementById("password-toggle") as HTMLButtonElement;
const $toggleIcon = document.getElementById("password-toggle-icon") as HTMLSpanElement;

function setStatus(text: string, isError = false) {
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

async function attemptLogin() {
  const pw = $password.value;
  if (!pw) {
    setStatus("Password required.", true);
    return;
  }
  setButtonLoading($loginBtn, true);
  setStatus("Signing in…");
  try {
    if (!(await pingAuth(pw))) {
      setStatus("Wrong password.", true);
      $password.select();
      return;
    }
    saveAdminToken(pw);
    $password.value = "";
    setStatus("");
    location.replace("/admin.html");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : "Login failed", true);
  } finally {
    setButtonLoading($loginBtn, false);
  }
}

$loginBtn.addEventListener("click", () => void attemptLogin());
$password.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    void attemptLogin();
  }
});

$toggle.addEventListener("click", () => {
  const showing = $password.type === "text";
  $password.type = showing ? "password" : "text";
  $toggleIcon.textContent = showing ? "👁" : "🙈";
  $toggle.setAttribute("aria-label", showing ? "Show password" : "Hide password");
  $password.focus();
});

$password.focus();
