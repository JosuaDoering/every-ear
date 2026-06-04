// Generates two sets of PNGs:
//   * tray-icon.png + tray-icon@2x.png — small black-on-transparent template
//     images for the macOS menu bar / Windows system tray.
//   * icon.png — 512×512 coloured app-bundle icon (electron-builder requires
//     ≥ 512px for the .app icon).
//
// Pure Node — no native deps. Encodes RGBA → PNG (uncompressed scanlines +
// zlib IDAT) and a tiny CRC32 implementation.

import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "..", "resources");

// NB: the call site is at the bottom of the file so all `const` declarations
// (CRC_TABLE in particular) have completed initialisation before main runs.

// ---------------------------------------------------------------------------

function writeIcon(size, dst, painter) {
  const pixels = new Uint8Array(size * size * 4);
  painter(pixels, size);
  const png = encodePngRGBA(size, size, pixels);
  writeFileSync(dst, png);
}

/**
 * Tray painter — black-on-transparent speech bubble. macOS interprets this
 * as a template image (alpha-only); Windows uses it directly.
 */
function paintTrayBubble(buf, size) {
  drawBubble(buf, size, {
    inkR: 0,
    inkG: 0,
    inkB: 0,
    inkA: 255,
    fill: false, // background stays transparent
  });
}

/**
 * App-bundle painter — brand-coloured square with a white speech bubble
 * centred on it. Used as the .app icon (≥ 512×512 required).
 */
function paintAppBubble(buf, size) {
  // Brand gradient anchor colours from frontend/src/styles.css:
  //   #5a7ad6 (top-left) → #f66161 (bottom-right) via #7a4dbf.
  // We approximate with a diagonal two-stop interpolation; close enough at
  // 512px to look clean without bringing in a real gradient compositor.
  const c0 = [0x5a, 0x7a, 0xd6];
  const c1 = [0xf6, 0x61, 0x61];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * (size - 1));
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * t);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * t);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * t);
      const i = (y * size + x) * 4;
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = 255;
    }
  }

  drawBubble(buf, size, {
    inkR: 255,
    inkG: 255,
    inkB: 255,
    inkA: 255,
    fill: true,
  });
}

/**
 * Shared bubble geometry used by both the tray template and the app icon.
 * `fill: true` means the background pixels are kept; `fill: false` means
 * non-bubble pixels are left at whatever the buffer already contained
 * (which for the tray is zero = transparent).
 */
function drawBubble(buf, size, opts) {
  const { inkR, inkG, inkB, inkA } = opts;

  const inset = Math.max(1, Math.round(size * 0.13));
  const tailH = Math.round(size * 0.18);
  const bodyTop = inset;
  const bodyBottom = size - inset - tailH;
  const bodyLeft = inset;
  const bodyRight = size - inset;
  const radius = Math.max(2, Math.round(size * 0.18));

  const tailX0 = bodyLeft + Math.round(size * 0.22);
  const tailX1 = tailX0 + Math.round(size * 0.20);
  const tailY1 = size - inset;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      let ink = false;

      if (x >= bodyLeft && x <= bodyRight && y >= bodyTop && y <= bodyBottom) {
        const dx = Math.min(x - bodyLeft, bodyRight - x);
        const dy = Math.min(y - bodyTop, bodyBottom - y);
        if (dx < radius && dy < radius) {
          const rx = radius - dx;
          const ry = radius - dy;
          ink = rx * rx + ry * ry <= radius * radius;
        } else {
          ink = true;
        }
      } else if (
        x >= tailX0 &&
        x <= tailX1 &&
        y >= bodyBottom &&
        y <= tailY1
      ) {
        const fy = y - bodyBottom;
        const fx = tailX1 - x;
        ink = fx >= fy;
      }

      if (ink) {
        buf[i] = inkR;
        buf[i + 1] = inkG;
        buf[i + 2] = inkB;
        buf[i + 3] = inkA;
      }
    }
  }

  // Punch a single contrast dot in the bubble centre.
  const dotR = Math.max(1, Math.round(size * 0.08));
  const dotX = Math.round((bodyLeft + bodyRight) / 2);
  const dotY = Math.round((bodyTop + bodyBottom) / 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dxd = x - dotX;
      const dyd = y - dotY;
      if (dxd * dxd + dyd * dyd <= dotR * dotR) {
        const i = (y * size + x) * 4;
        if (opts.fill) {
          // app icon: punch with the gradient colour by setting alpha to 0
          // would expose the *transparent* parts behind, which we don't want.
          // Instead, paint the dot with a lower-saturation brand tint so it
          // reads as a separate disc.
          buf[i] = 0x33;
          buf[i + 1] = 0x40;
          buf[i + 2] = 0x80;
          buf[i + 3] = 255;
        } else {
          // tray: punch transparency for clean monochrome contrast.
          buf[i + 3] = 0;
        }
      }
    }
  }
}

// ---- PNG encoder (RGBA, no filter) ----------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff >>> 0;
  for (let i = 0; i < buf.length; i++) {
    c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, payload) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, payload])), 0);
  return Buffer.concat([len, t, payload, crc]);
}

function encodePngRGBA(width, height, pixels) {
  const sig = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowBytes = 1 + width * 4;
  const raw = Buffer.alloc(height * rowBytes);
  for (let y = 0; y < height; y++) {
    raw[y * rowBytes] = 0;
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = y * rowBytes + 1 + x * 4;
      raw[dst]     = pixels[src];
      raw[dst + 1] = pixels[src + 1];
      raw[dst + 2] = pixels[src + 2];
      raw[dst + 3] = pixels[src + 3];
    }
  }

  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- entry -----------------------------------------------------------------

mkdirSync(outDir, { recursive: true });

writeIcon(22, path.join(outDir, "tray-icon.png"), paintTrayBubble);
writeIcon(44, path.join(outDir, "tray-icon@2x.png"), paintTrayBubble);
writeIcon(512, path.join(outDir, "icon.png"), paintAppBubble);

console.log(
  "✓ Wrote tray-icon.png (22×22), tray-icon@2x.png (44×44), icon.png (512×512)",
);
