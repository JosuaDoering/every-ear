// Small UI helpers shared by all pages. Hand-rolled, no dependencies.

// ---- Toast notifications ---------------------------------------------------

type ToastKind = "info" | "success" | "error";

function ensureToastStack(): HTMLDivElement {
  let stack = document.querySelector<HTMLDivElement>(".toast-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

export function toast(message: string, kind: ToastKind = "info", ms = 3200): void {
  const stack = ensureToastStack();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  stack.appendChild(el);
  window.setTimeout(() => {
    el.classList.add("is-leaving");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  }, ms);
}

// ---- Confirm dialog --------------------------------------------------------

type ConfirmOpts = {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";

    const modal = document.createElement("div");
    modal.className = "modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");

    const header = document.createElement("header");
    header.className = "modal-header";
    const headerText = document.createElement("div");
    headerText.className = "modal-header-text";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title;
    headerText.appendChild(h2);
    if (opts.message) {
      const p = document.createElement("p");
      p.className = "hint";
      p.textContent = opts.message;
      headerText.appendChild(p);
    }
    header.appendChild(headerText);
    modal.appendChild(header);

    const footer = document.createElement("footer");
    footer.className = "modal-footer";

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "ghost";
    cancelBtn.textContent = opts.cancelLabel ?? "Cancel";

    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = opts.danger ? "danger" : "primary";
    okBtn.textContent = opts.confirmLabel ?? "Confirm";

    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);
    modal.appendChild(footer);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    const close = (result: boolean) => {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
      resolve(result);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      else if (e.key === "Enter") close(true);
    };

    cancelBtn.addEventListener("click", () => close(false));
    okBtn.addEventListener("click", () => close(true));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close(false);
    });
    document.addEventListener("keydown", onKey);

    okBtn.focus();
  });
}

// ---- Button loading state --------------------------------------------------

export function setButtonLoading(btn: HTMLButtonElement, loading: boolean): void {
  btn.classList.toggle("is-loading", loading);
  btn.disabled = loading;
}

// ---- Click-to-edit heading -------------------------------------------------

type InlineEditOpts = {
  element: HTMLElement;
  onCommit: (next: string) => void | Promise<void>;
  maxLength?: number;
};

// Turns an element into a click-to-edit field. Saves on Enter or blur,
// cancels on Escape.
export function inlineEdit({ element, onCommit, maxLength = 80 }: InlineEditOpts): void {
  element.classList.add("inline-edit");
  element.setAttribute("role", "textbox");
  element.setAttribute("tabindex", "0");
  element.title = "Click to rename";

  const startEditing = () => {
    const original = element.textContent ?? "";
    element.setAttribute("contenteditable", "plaintext-only");
    element.focus();
    // Select all
    const range = document.createRange();
    range.selectNodeContents(element);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const finish = (commit: boolean) => {
      element.removeAttribute("contenteditable");
      element.removeEventListener("keydown", onKey);
      element.removeEventListener("blur", onBlur);
      const next = (element.textContent ?? "").trim().slice(0, maxLength);
      if (commit && next && next !== original) {
        element.textContent = next;
        void onCommit(next);
      } else {
        element.textContent = original;
      }
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false);
      }
    };
    const onBlur = () => finish(true);

    element.addEventListener("keydown", onKey);
    element.addEventListener("blur", onBlur);
  };

  element.addEventListener("click", startEditing);
  element.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !element.hasAttribute("contenteditable")) {
      e.preventDefault();
      startEditing();
    }
  });
}
