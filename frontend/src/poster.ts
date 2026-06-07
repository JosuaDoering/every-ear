// Composes the shareable "connection poster": a printable image with the
// event Wi-Fi QR code on the left and the listener QR code on the right, each
// clearly labelled in English. Everything is drawn onto a single <canvas> so
// it can be downloaded as a PNG or copied to the clipboard. The QR codes come
// from the `qrcode` package the admin page already bundles.

import QRCode from "qrcode";

export type WifiAuth = "WPA" | "WEP" | "nopass";

/** The primary QR column — either the listener page or the translator page. */
export type PosterTarget = {
  /** The https URL the QR encodes and that's printed as a caption. */
  url: string;
  /** Column heading, e.g. "Listen live" or "Translator login". */
  heading: string;
  /** One-line instruction shown under the heading. */
  instruction: string;
};

export type PosterData = {
  /** Big headline drawn at the top of the poster. */
  title: string;
  /** The primary QR (listener or translator page). */
  target: PosterTarget;
  /** Wi-Fi details, or null to render the target code on its own. */
  wifi: {
    ssid: string;
    password: string;
    auth: WifiAuth;
    hidden: boolean;
  } | null;
};

const FONT = `"Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;

const C = {
  pageTop: "#eef2ff",
  page: "#f7f8fa",
  card: "#ffffff",
  border: "#e2e8f0",
  fg: "#0f172a",
  muted: "#64748b",
  mutedSoft: "#94a3b8",
  brand: "#4f46e5",
  qrDark: "#0f172a",
};

// Render dimensions. Generous so the exported PNG stays crisp when printed.
const W = 2400;
const H = 1640;

/** Build the standard Wi-Fi QR payload, escaping the reserved characters. */
export function wifiQrPayload(w: {
  ssid: string;
  password: string;
  auth: WifiAuth;
  hidden: boolean;
}): string {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  const parts = [`T:${w.auth}`, `S:${esc(w.ssid)}`];
  if (w.auth !== "nopass") parts.push(`P:${esc(w.password)}`);
  if (w.hidden) parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

async function makeQrCanvas(text: string, size: number): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, text, {
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: C.qrDark, light: "#ffffff" },
  });
  return canvas;
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/** Draw text shrinking the font until it fits within maxWidth. */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  cx: number,
  y: number,
  maxWidth: number,
  startPx: number,
  weight: number,
  family: string = FONT,
): void {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxWidth && px > 18) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  ctx.fillText(text, cx, y);
}

type Column = {
  x: number;
  width: number;
  step: string;
  heading: string;
  instruction: string;
  qr: HTMLCanvasElement;
  /** Caption lines shown under the QR; label is small + uppercase. */
  captions: { label: string; value: string; mono?: boolean }[];
};

function drawColumn(ctx: CanvasRenderingContext2D, col: Column, top: number, height: number): void {
  const { x, width } = col;
  const cx = x + width / 2;
  const pad = 56;
  const mono = `ui-monospace, "SF Mono", Menlo, Consolas, monospace`;

  // Card background with soft shadow, then border on top.
  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.08)";
  ctx.shadowBlur = 48;
  ctx.shadowOffsetY = 20;
  ctx.fillStyle = C.card;
  roundRect(ctx, x, top, width, height, 36);
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  roundRect(ctx, x, top, width, height, 36);
  ctx.stroke();

  ctx.textAlign = "center";

  // Step badge.
  const badgeY = top + 96;
  ctx.fillStyle = C.brand;
  ctx.beginPath();
  ctx.arc(cx, badgeY, 44, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = `700 48px ${FONT}`;
  ctx.textBaseline = "middle";
  ctx.fillText(col.step, cx, badgeY + 3);
  ctx.textBaseline = "alphabetic";

  // Heading + instruction.
  ctx.fillStyle = C.fg;
  fitText(ctx, col.heading, cx, top + 210, width - pad * 2, 58, 700);
  ctx.fillStyle = C.muted;
  fitText(ctx, col.instruction, cx, top + 270, width - pad * 2, 32, 400);

  // QR tile (white framed square).
  const tile = 600;
  const tileX = cx - tile / 2;
  const tileY = top + 310;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = C.border;
  ctx.lineWidth = 2;
  roundRect(ctx, tileX, tileY, tile, tile, 28);
  ctx.fill();
  ctx.stroke();
  const qrSize = tile - 56;
  ctx.drawImage(col.qr, cx - qrSize / 2, tileY + 28, qrSize, qrSize);

  // Captions under the QR.
  let cy = tileY + tile + 76;
  for (const cap of col.captions) {
    ctx.fillStyle = C.mutedSoft;
    ctx.font = `700 24px ${FONT}`;
    ctx.fillText(cap.label.toUpperCase(), cx, cy);
    cy += 48;
    ctx.fillStyle = C.fg;
    fitText(ctx, cap.value, cx, cy, width - pad * 2, cap.mono ? 40 : 44, 700, cap.mono ? mono : FONT);
    cy += 70;
  }
}

export async function renderPoster(canvas: HTMLCanvasElement, data: PosterData): Promise<void> {
  // Make sure the brand webfont is ready, otherwise the first render falls
  // back to a system font and the poster looks off.
  if (document.fonts?.ready) {
    try {
      await document.fonts.ready;
    } catch {
      /* non-fatal */
    }
  }

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");

  // Page background — subtle top-to-bottom wash.
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, C.pageTop);
  grad.addColorStop(0.4, C.page);
  grad.addColorStop(1, C.page);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  // Top accent bar.
  ctx.fillStyle = C.brand;
  ctx.fillRect(0, 0, W, 16);

  // Header — fixed title, no subtitle.
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = C.fg;
  ctx.font = `700 100px ${FONT}`;
  ctx.fillText(data.title, W / 2, 184);

  // Columns.
  const margin = 120;
  const gap = 110;
  const top = 290;
  const height = 1250;
  const twoUp = !!data.wifi;
  const qrSize = 560;

  if (twoUp && data.wifi) {
    const colW = (W - margin * 2 - gap) / 2;
    const [wifiQr, targetQr] = await Promise.all([
      makeQrCanvas(wifiQrPayload(data.wifi), qrSize),
      makeQrCanvas(data.target.url, qrSize),
    ]);

    const wifiCaptions: Column["captions"] = [
      { label: "Network", value: data.wifi.ssid },
    ];
    if (data.wifi.auth !== "nopass" && data.wifi.password) {
      wifiCaptions.push({ label: "Password", value: data.wifi.password, mono: true });
    } else if (data.wifi.auth === "nopass") {
      wifiCaptions.push({ label: "Password", value: "Open network — none" });
    }

    drawColumn(
      ctx,
      {
        x: margin,
        width: colW,
        step: "1",
        heading: "Join the Wi-Fi",
        instruction: "Scan to connect your phone to the network.",
        qr: wifiQr,
        captions: wifiCaptions,
      },
      top,
      height,
    );
    drawColumn(
      ctx,
      {
        x: margin + colW + gap,
        width: colW,
        step: "2",
        heading: data.target.heading,
        instruction: data.target.instruction,
        qr: targetQr,
        captions: [{ label: "Or open", value: data.target.url, mono: true }],
      },
      top,
      height,
    );
  } else {
    const colW = 1180;
    const targetQr = await makeQrCanvas(data.target.url, qrSize);
    drawColumn(
      ctx,
      {
        x: (W - colW) / 2,
        width: colW,
        step: "1",
        heading: data.target.heading,
        instruction: data.target.instruction,
        qr: targetQr,
        captions: [{ label: "Or open", value: data.target.url, mono: true }],
      },
      top,
      height,
    );
  }

  // Footer.
  ctx.fillStyle = C.muted;
  ctx.textAlign = "center";
  ctx.font = `400 32px ${FONT}`;
  ctx.fillText("Point your phone camera at a code.", W / 2, H - 60);
}
