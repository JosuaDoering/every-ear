/**
 * Fixes livekit-server-sdk dist/*.d.ts files which incorrectly reference
 * TypeScript source files ('..\/src\/Foo.ts') instead of compiled dist stubs
 * ('.\/Foo.js'). This causes TypeScript to compile the raw source under the
 * project's own strict config, producing spurious errors on newer TS versions.
 *
 * Runs automatically via the postinstall hook.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, "../node_modules/livekit-server-sdk/dist");

if (!existsSync(distDir)) process.exit(0);

let patchedCount = 0;
for (const file of readdirSync(distDir)) {
  if (!file.endsWith(".d.ts") && !file.endsWith(".d.cts")) continue;
  const filePath = join(distDir, file);
  const original = readFileSync(filePath, "utf8");
  // Replace `'../src/Foo.ts'` → `'./Foo.js'`  (TS resolves .js → .d.ts in NodeNext)
  const patched = original.replace(/'\.\.\/src\/([^']+)\.ts'/g, "'./$1.js'");
  if (patched !== original) {
    writeFileSync(filePath, patched, "utf8");
    patchedCount++;
  }
}

if (patchedCount > 0) {
  console.log(`patch-livekit-types: fixed ${patchedCount} dist/*.d.ts src→dist redirects`);
}
