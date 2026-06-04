# Every Ear

Self-hosted live translation for large events. Translators stream audio from the browser, listeners open a website and press ▶︎ — no registration, no app. Target latency in LAN: < 300 ms.

Stack: LiveKit (WebRTC-SFU) · Node + Fastify (Tokens) · Vite + Vanilla TS (Frontend) · Caddy (HTTPS-Proxy). Runs on macOS and Windows 11 in the event LAN.

## First Setup

### macOS

```bash
./scripts/install-mac.sh    # Homebrew packages + npm install + create .env
$EDITOR .env                # Set ADMIN_PASSWORD, adjust languages
```

### Windows 11

Open PowerShell or a terminal in the project folder and run:

```powershell
.\scripts\install-windows.cmd     # winget packages + LiveKit binary + npm install + URL ACL + firewall + .env
notepad .env                      # Set ADMIN_PASSWORD, adjust languages
```

The installer triggers a single UAC prompt to register the URL ACL for `https://+:443/` and to open Windows Firewall ports 443, 7881 (TCP), and 7882 (UDP). Everything else runs as your normal user.

`install-windows.cmd` is a thin wrapper around `install-windows.ps1` that bypasses PowerShell's default execution policy, so no `Set-ExecutionPolicy` change is needed.

## Event Day

### macOS

1. Connect host to the event network via **Ethernet (USB-C adapter)**, connect **power**.
2. `./scripts/start.sh` — starts LiveKit, backend, frontend, Caddy. Asks once for `sudo` (for port 443), then `caffeinate` keeps the system awake.
3. In another terminal: `./scripts/show-url.sh` — shows URL + QR code for the listeners.

### Windows 11

1. Connect host to the event network via **Ethernet**, connect **power**.
2. `.\scripts\start.cmd` — starts LiveKit, backend, frontend, Caddy. Sleep / display blanking is suppressed for the duration via `SetThreadExecutionState`.
3. In another terminal: `.\scripts\show-url.cmd` — shows URL + QR code for the listeners.

### Both platforms

4. Admin: open `https://<lan-ip>/admin.html`, log in with `ADMIN_PASSWORD`, generate **a code for each translator** (Event → Language + Name → 6-digit code).
5. Translators open `https://<lan-ip>/translator.html`, enter **only the code**, click connect.

## What the Listeners Do

1. Open website, accept certificate once (Caddy `tls internal`, no internet needed).
2. Choose event, choose language (with flag), press ▶ — done.
3. As soon as the translator broadcasts, "🇬🇧 Anna is translating for you" appears.

## How Auth Works

- **Listeners**: Backend anonymously issues a subscribe-only JWT to everyone for exactly one event-and-language room.
- **Translators**: Code (6-digit) → backend verifies + issues a publish JWT scoped to one event/language with the translator's display name.
- **Admin**: Bearer token against `ADMIN_PASSWORD`. Codes, events, languages, and uploaded backgrounds live under `backend/data/` (survives restarts).
- LiveKit API key/secret remain on the server; the frontend only gets short-lived JWTs.

## Changing Languages

Open `https://<lan-ip>/admin.html`, click **Languages** in the header, then add/remove/edit. The list is persisted in `backend/data/languages.json`. The first time the backend boots, it seeds the list from `LANGUAGES`/`LANGUAGE_NAMES`/`LANGUAGE_FLAGS` in `.env` — those env vars are only used as the initial seed.

## Testing Latency

In a second terminal:

```bash
livekit-cli load-test \
  --url ws://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room event-<id>-lang-en --subscribers 200 --duration 60s
```

Target on M-series / modern Windows: < 30% CPU, smooth audio with 200+ subscribers.

## Troubleshooting

- **Listener hears nothing** → tap ▶︎ again. On iOS, audio only starts after a touch (browser policy).
- **"Microphone access denied"** for the translator →
  - macOS: System Settings ▸ Privacy ▸ Microphone → allow browser.
  - Windows: Settings ▸ Privacy & security ▸ Microphone → allow desktop apps.
  - The translator page also needs HTTPS — `localhost` and Caddy's internal CA are both OK.
- **Listener device cannot connect** → Accept Caddy's cert (Browser warning "Advanced ▸ proceed anyway"). Alternatively, distribute the Caddy root once:
  - macOS: `cat ~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt`
  - Windows: `%LOCALAPPDATA%\Caddy\pki\authorities\local\root.crt`
- **Audio drops out** → Event Wi-Fi has too little bandwidth. For 500 listeners × 50 kbit/s = 25 Mbit/s. Use Ethernet between the host and Wi-Fi access points.
- **"Address already in use" on Windows** → Skype, IIS, or another service holds 443. Stop it, or change the Caddyfile.
  ```powershell
  Get-NetTCPConnection -LocalPort 443 -State Listen
  ```
- **"Address already in use" on macOS** → `lsof -nP -iTCP:443 -sTCP:LISTEN`
- **Windows: Caddy says "permission denied" on :443** → Re-run `install-windows.cmd` once; it adds the URL ACL reservation. Or run start.cmd from an elevated terminal.
- **PowerShell blocks the script** → use `.\scripts\start.cmd` (the cmd wrapper bypasses the execution policy). Direct `.ps1` invocation requires `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

## Desktop App (.app / .exe)

Every Ear can also be packaged as a tray-only desktop app for macOS and Windows 11. The app bundles `livekit-server`, the Node backend, the prebuilt frontend and Caddy, opens a settings window on first launch, and otherwise lives in the menu bar / system tray. Listeners still connect via browser at `https://<auto-detected-ip>/`.

**Install desktop dependencies (once):**

```bash
npm run install:all          # also installs desktop/
```

**Build a packaged app for the current OS:**

```bash
npm run desktop:dist:mac     # → desktop/dist/Every Ear-0.1.0-arm64.dmg + -x64.dmg
npm run desktop:dist:win     # → desktop/dist/Every Ear-Setup-0.1.0.exe
```

The `dist:*` scripts download pinned LiveKit + Caddy binaries on demand into `desktop/resources/bin/<os>/<arch>/` and bundle them as Electron extra-resources.

**Dev iteration on the desktop wrapper:**

```bash
npm run desktop:dev          # builds + launches Electron against the live source
```

Dev mode falls back to PATH-resolved `livekit-server` / `caddy` (so a brew/winget install still works without the fetch-binaries step).

**First launch:** a one-time modal shows the auto-generated admin password. Copy it. The app then settles in the tray; click the icon to reach the settings window.

**Settings window** has three sections:
- *Connection* — listener URL, copy button, scannable QR, and a network-interface picker if more than one private interface is up.
- *Admin password* — change + Save (the backend restarts automatically; takes ~2s).
- *Advanced* — regenerate LiveKit credentials, reset all data, reveal the log folder.

**Where the data lives:**
- macOS: `~/Library/Application Support/every-ear/{config.json,data/,logs/}`
- Windows: `%APPDATA%\every-ear\{config.json,data\,logs\}`

**Unsigned-build caveats:** the current builds are not code-signed. macOS Gatekeeper will refuse the first launch — right-click the app → Open. Windows SmartScreen will warn — More info → Run anyway. Both can be removed later by adding signing identities to `desktop/electron-builder.yml`.

## Development Mode

Vite Hot-Reload, tsx-Watch for the backend, Caddy with `tls internal` — `./scripts/start.sh` (mac) / `.\scripts\start.cmd` (Windows) does everything at once. Code changes appear immediately in the browser.

For production (static frontend instead of Vite-Dev):

```bash
npm run build       # at repo root — runs vite build for the frontend
```

Rewrite Caddyfile so it serves `frontend/dist/` as `root` (instead of proxy to `:5173`), and remove the `frontend` process from the `Procfile` / `scripts/dev.mjs` list.
