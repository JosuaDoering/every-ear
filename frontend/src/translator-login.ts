import {
  loadTranslatorGrant,
  saveTranslatorGrant,
  type TranslatorGrant,
} from "./session.js";

// If we're already signed in, jump straight to the broadcast page.
if (loadTranslatorGrant()) {
  location.replace("/translator.html");
}

const $otp = document.getElementById("otp") as HTMLDivElement;
const $verifyBtn = document.getElementById("verify-code") as HTMLButtonElement;
const $status = document.getElementById("status") as HTMLDivElement | null;

const otpInputs = Array.from($otp.querySelectorAll<HTMLInputElement>("input"));
let verifying = false;

function setStatus(text: string, isError = false) {
  if (!$status) return;
  $status.textContent = text;
  $status.classList.toggle("error", isError);
}

function otpValue(): string {
  return otpInputs.map((i) => i.value).join("");
}

function updateVerifyButton() {
  $verifyBtn.disabled = verifying || !/^\d{6}$/.test(otpValue());
}

function clearOtp() {
  for (const i of otpInputs) {
    i.value = "";
    i.classList.remove("filled");
  }
  $otp.classList.remove("error");
  otpInputs[0]?.focus();
  updateVerifyButton();
}

function shakeOtp() {
  $otp.classList.remove("error");
  void $otp.offsetWidth;
  $otp.classList.add("error");
}

otpInputs.forEach((input, idx) => {
  input.addEventListener("input", () => {
    const v = input.value;
    if (v.length > 1) {
      const digits = v.replace(/\D/g, "").slice(0, otpInputs.length - idx);
      digits.split("").forEach((ch, i) => {
        const target = otpInputs[idx + i];
        if (!target) return;
        target.value = ch;
        target.classList.add("filled");
      });
      const next = Math.min(idx + digits.length, otpInputs.length - 1);
      otpInputs[next]?.focus();
      maybeSubmitOtp();
      return;
    }
    if (!/^\d$/.test(v)) {
      input.value = "";
      input.classList.remove("filled");
      updateVerifyButton();
      return;
    }
    input.classList.add("filled");
    if (idx < otpInputs.length - 1) otpInputs[idx + 1]?.focus();
    maybeSubmitOtp();
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Backspace") {
      if (input.value === "" && idx > 0) {
        e.preventDefault();
        const prev = otpInputs[idx - 1]!;
        prev.value = "";
        prev.classList.remove("filled");
        prev.focus();
        updateVerifyButton();
      }
    } else if (e.key === "ArrowLeft" && idx > 0) {
      e.preventDefault();
      otpInputs[idx - 1]?.focus();
    } else if (e.key === "ArrowRight" && idx < otpInputs.length - 1) {
      e.preventDefault();
      otpInputs[idx + 1]?.focus();
    } else if (e.key === "Enter") {
      e.preventDefault();
      const code = otpValue();
      if (/^\d{6}$/.test(code)) void verifyCode(code);
    }
  });

  input.addEventListener("focus", () => input.select());
});

$otp.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = e.clipboardData?.getData("text") ?? "";
  const digits = text.replace(/\D/g, "").slice(0, otpInputs.length).split("");
  otpInputs.forEach((input, i) => {
    const ch = digits[i] ?? "";
    input.value = ch;
    input.classList.toggle("filled", ch !== "");
  });
  const next = Math.min(digits.length, otpInputs.length - 1);
  otpInputs[next]?.focus();
  maybeSubmitOtp();
});

function maybeSubmitOtp() {
  updateVerifyButton();
  const code = otpValue();
  if (code.length === otpInputs.length && /^\d{6}$/.test(code)) {
    void verifyCode(code);
  }
}

async function verifyCode(code: string) {
  if (verifying) return;
  verifying = true;
  updateVerifyButton();
  for (const i of otpInputs) i.disabled = true;
  setStatus("Verifying code…");
  try {
    const res = await fetch("/api/token/translator", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.status === 404) throw new Error("Code not recognised.");
    if (res.status === 400) throw new Error("Code must be 6 digits.");
    if (!res.ok) throw new Error(`Verification failed (${res.status}).`);
    const grant = (await res.json()) as TranslatorGrant;
    saveTranslatorGrant(grant);
    setStatus("Signed in.");
    location.replace("/translator.html");
  } catch (err) {
    console.error(err);
    setStatus(err instanceof Error ? err.message : "Verification failed.", true);
    shakeOtp();
    setTimeout(() => clearOtp(), 350);
  } finally {
    verifying = false;
    for (const i of otpInputs) i.disabled = false;
    updateVerifyButton();
  }
}

$verifyBtn.addEventListener("click", () => {
  const code = otpValue();
  if (/^\d{6}$/.test(code)) void verifyCode(code);
});

otpInputs[0]?.focus();
