// Copies static renderer assets (HTML, CSS, anything non-bundled) from
// renderer/ into build/renderer/ so they sit next to the esbuild output.
// Cross-platform — uses Node fs APIs only.

import { copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const src = path.join(desktopRoot, "renderer");
const dst = path.join(desktopRoot, "build", "renderer");

await mkdir(dst, { recursive: true });

for (const file of ["settings.html", "settings.css"]) {
  await copyFile(path.join(src, file), path.join(dst, file));
}
