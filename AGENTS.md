# AGENTS.md

## Repository overview

Every Ear is a self-hosted VoIP desktop app: an Electron shell (`desktop/`) that
supervises a Node backend (`backend/`) serving a Vite/React frontend
(`frontend/`), with LiveKit (media) and Caddy (TLS/reverse proxy) as native
sidecars.

## Build and verification commands

```bash
npm ci                       # root; also needed in backend/, frontend/, desktop/
npm run desktop:fetch-binaries   # native sidecars → desktop/resources/bin/<os>/<arch>/
npm run desktop:build            # backend tsc + frontend vite + desktop tsc
npm run desktop:dev              # electron + backend + caddy via scripts/dev.mjs
```

There is no test suite in this repo. Verification means: `tsc --noEmit` for each
package, `node --check` for plain `.mjs` scripts, and packing the app with
electron-builder to confirm the payload actually contains the sidecar binaries.

## Desktop packaging constraints (learned the hard way)

- **`desktop/package.json` must keep `homepage` and `author.email`.** Linux `.deb`
  packaging aborts without them ("Please specify project homepage" / "author
  'email'") because electron-builder derives the maintainer field from them.
- **`fetch-binaries.mjs` must fetch every arch that `electron-builder.yml`
  packages.** If an arch directory is missing, electron-builder only logs
  `file source doesn't exist` and ships an app whose `resources/bin/` is empty —
  the build passes and the app fails at runtime. Linux packages both x64 and
  arm64 AppImages, so both arches must be populated; mac defaults to arm64 only
  (`EVERY_EAR_MAC_ARCHS` widens it); win is x64.
- **Never `rename()` across filesystems.** The download temp dir is on a
  different device than the checkout on the Windows runners (C: vs D:) and in
  some containers, which throws `EXDEV`. Use the `moveFile` helper in
  `fetch-binaries.mjs`, which falls back to copy + remove.
- **LiveKit on macOS is compiled from source and needs `CGO_ENABLED=1`.**
  `livekit/protocol`'s hwstats package calls `cpu.Stats`/`cpu.Get`, which only
  exist in go-osstat's cgo variant on darwin; with cgo off the build fails with
  `undefined: cpu.Stats`. clang comes from the runner's Xcode toolchain.
- **Only reuse a Homebrew `livekit-server` whose version matches
  `LIVEKIT_VERSION`**, otherwise mac ships a different server than Linux/Windows.
- `resources/icon.icns` and `icon.ico` are not committed on purpose:
  electron-builder converts `resources/icon.png` at pack time. The
  "`icon.icns` not found" warnings are noise, not errors.

## CI

`.github/workflows/build.yml` runs on every PR (mac/win/linux) and
`.github/workflows/release.yml` on `v*` tags. Both use the same fetch and build
steps, so a fix must hold for both. Validate workflow edits with `actionlint`.
