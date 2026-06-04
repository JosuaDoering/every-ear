# Every Ear

**Live translation for your event — straight to people's phones, no app needed.**

A translator speaks into a microphone. Everyone in the room opens a website on their
phone, picks their language, and presses play. That's it. No app store, no sign-up, no
internet required — everything runs on one computer in the room.

> **Who is this guide for?** You don't need to be a programmer. If you can copy and paste
> a line of text and press Enter, you can set this up. Just follow the steps in order.

---

## What you need

- **One computer** to run everything (a Mac or a Windows 11 PC). This is the "host".
- **A network** that everyone is on — ideally a Wi-Fi router with the host plugged in by
  cable (Ethernet). You do **not** need internet access.
- **A microphone** for each translator (a headset works great).
- **Phones** for the listeners — any modern phone with a browser.

---

## A few words you'll see in this guide

| Word | What it means |
|------|---------------|
| **Host** | The one computer that runs the software. |
| **Terminal** | A text window where you type commands. On Mac it's the "Terminal" app; on Windows it's "PowerShell". |
| **Translator** | The person speaking the translation into a microphone. |
| **Listener** | A guest who listens on their phone. |
| **Admin** | You — the person setting things up and handing out codes. |

When this guide shows a box like the one below, it means: **type (or paste) that line
into your Terminal and press Enter.**

```bash
this is a command
```

---

## Step 1 — Install once (only the first time)

Open a Terminal in the project folder, then run the line for your system.

### On a Mac

```bash
./scripts/install-mac.sh
```

This installs the needed software, gets everything ready, and creates a settings file
called `.env`.

### On Windows 11

```powershell
.\scripts\install-windows.cmd
```

Windows will show **one security pop-up** (a "User Account Control" prompt) asking for
permission. Click **Yes** — this lets people reach the website and opens the right network
ports. Everything else runs normally without admin rights.

### Set your admin password

After installing, open the `.env` settings file and set a password. This password is how
**you** log in later to hand out translator codes. You can also adjust the list of
languages here.

- **Mac:** `open -e .env` (opens it in TextEdit)
- **Windows:** `notepad .env`

Find the line `ADMIN_PASSWORD=` and type your password right after the `=`. Save and close.

---

## Step 2 — On the day of the event

### Get everything running

1. Plug the host computer into the event network **by cable** and plug in the **power**.
2. Start the software:
   - **Mac:** `./scripts/start.sh`
   - **Windows:** `.\scripts\start.cmd`

   On a Mac it asks once for your computer password (this is normal — it's needed to run
   the website). The computer is also kept awake automatically so nothing stops mid-event.

3. **Leave that window open.** Closing it stops the event.

### Show people where to go

Open a **second** Terminal window and run:

- **Mac:** `./scripts/show-url.sh`
- **Windows:** `.\scripts\show-url.cmd`

This shows a web address **and a QR code**. Put the QR code on a screen or print it —
listeners just scan it with their phone camera.

### Create a code for each translator

1. On the host, open the web address it gave you and add `/admin.html` to the end
   (for example `https://192.168.1.50/admin.html`).
2. Log in with the **admin password** you set earlier.
3. For each translator, create a code: pick the **event**, the **language**, and a
   **name**. You get a **6-digit code**. Give that code to the translator.

### What the translator does

1. Open the same web address and add `/translator.html` to the end.
2. Type in **only the 6-digit code** you gave them.
3. Click **connect** and start speaking. (The browser will ask to use the microphone —
   click **Allow**.)

### What the listeners do

1. Scan the QR code (or open the web address).
2. The first time, the phone shows a security warning because the host makes its own
   certificate. Tap **Advanced ▸ proceed anyway** — this is safe on your own network.
3. Choose the event, choose the language (each has a flag), and press **▶**.
4. When the translator starts speaking, it shows something like
   "🇬🇧 Anna is translating for you".

That's the whole event. 🎉

---

## Changing the list of languages

1. Open the web address and add `/admin.html`.
2. Log in, click **Languages** at the top.
3. Add, remove, or edit languages. Your changes are saved automatically and stay even
   after a restart.

---

## If something goes wrong

| Problem | What to do |
|---------|------------|
| **A listener hears nothing** | Tap **▶** again. On iPhones, sound only starts after a tap — that's an Apple rule, not a bug. |
| **The translator's microphone won't work** | Allow microphone access for the browser. **Mac:** System Settings ▸ Privacy ▸ Microphone. **Windows:** Settings ▸ Privacy & security ▸ Microphone. |
| **A phone can't connect / shows a warning** | Accept the security warning (**Advanced ▸ proceed anyway**). It only appears the first time. |
| **The sound keeps cutting out** | The Wi-Fi is overloaded. Use a cable between the host and the Wi-Fi router, and make sure the network can handle many people at once. |
| **"Address already in use"** | Another program is using the website port. Close other web/streaming apps (on Windows, Skype is a common culprit) and start again. |
| **Windows won't run the script** | Use `.\scripts\start.cmd` (note the `.cmd`). It's built to run without changing any Windows settings. |

If you get stuck, the most reliable fix is to close the Terminal windows, then start again
from **Step 2**.

---

<details>
<summary><strong>For technical users — details, testing, and advanced setup</strong> (click to expand)</summary>

### What it's built on

Self-hosted live translation for large events. Translators stream audio from the browser,
listeners open a website and press ▶︎ — no registration, no app. Target latency in LAN:
< 300 ms.

Stack: LiveKit (WebRTC-SFU) · Node + Fastify (tokens) · Vite + Vanilla TS (frontend) ·
Caddy (HTTPS proxy). Runs on macOS and Windows 11 in the event LAN.

### Install notes

`install-windows.cmd` is a thin wrapper around `install-windows.ps1` that bypasses
PowerShell's default execution policy, so no `Set-ExecutionPolicy` change is needed. The
single UAC prompt registers the URL ACL for `https://+:443/` and opens Windows Firewall
ports 443, 7881 (TCP), and 7882 (UDP).

The first time the backend boots, it seeds the language list from
`LANGUAGES`/`LANGUAGE_NAMES`/`LANGUAGE_FLAGS` in `.env`. After that the list lives in
`backend/data/languages.json` and the env vars are ignored.

### How auth works

- **Listeners**: backend anonymously issues a subscribe-only JWT for exactly one
  event-and-language room.
- **Translators**: 6-digit code → backend verifies and issues a publish JWT scoped to one
  event/language with the translator's display name.
- **Admin**: bearer token against `ADMIN_PASSWORD`. Codes, events, languages, and uploaded
  backgrounds live under `backend/data/` (survives restarts).
- LiveKit API key/secret stay on the server; the frontend only gets short-lived JWTs.

### Distributing the Caddy root certificate (instead of clicking through the warning)

- macOS: `cat ~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt`
- Windows: `%LOCALAPPDATA%\Caddy\pki\authorities\local\root.crt`

### Testing latency / load

```bash
livekit-cli load-test \
  --url ws://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room event-<id>-lang-en --subscribers 200 --duration 60s
```

Target on M-series / modern Windows: < 30% CPU, smooth audio with 200+ subscribers.
Bandwidth rule of thumb: 500 listeners × 50 kbit/s = 25 Mbit/s — use Ethernet between the
host and the Wi-Fi access points.

### Diagnosing a busy port

- Windows: `Get-NetTCPConnection -LocalPort 443 -State Listen`
- macOS: `lsof -nP -iTCP:443 -sTCP:LISTEN`
- Windows "permission denied" on :443: re-run `install-windows.cmd` once to add the URL ACL
  reservation, or run `start.cmd` from an elevated terminal.

### Desktop App (.app / .exe)

Every Ear can also be packaged as a tray-only desktop app for macOS and Windows 11. The app
bundles `livekit-server`, the Node backend, the prebuilt frontend, and Caddy, opens a
settings window on first launch, and otherwise lives in the menu bar / system tray.
Listeners still connect via browser at `https://<auto-detected-ip>/`.

```bash
npm run install:all          # also installs desktop/
npm run desktop:dist:mac     # → desktop/dist/Every Ear-0.1.0-arm64.dmg + -x64.dmg
npm run desktop:dist:win     # → desktop/dist/Every Ear-Setup-0.1.0.exe
npm run desktop:dev          # builds + launches Electron against the live source
```

The `dist:*` scripts download pinned LiveKit + Caddy binaries on demand into
`desktop/resources/bin/<os>/<arch>/`. Dev mode falls back to PATH-resolved
`livekit-server` / `caddy`.

On first launch a one-time modal shows the auto-generated admin password — copy it. The
settings window has three sections: *Connection* (listener URL, QR, network-interface
picker), *Admin password* (change + save, backend restarts in ~2s), and *Advanced*
(regenerate LiveKit credentials, reset all data, reveal the log folder).

Where the data lives:
- macOS: `~/Library/Application Support/every-ear/{config.json,data/,logs/}`
- Windows: `%APPDATA%\every-ear\{config.json,data\,logs\}`

**Unsigned-build caveats:** builds are not code-signed. macOS Gatekeeper refuses the first
launch — right-click the app → Open. Windows SmartScreen warns — More info → Run anyway.
Add signing identities to `desktop/electron-builder.yml` to remove these.

### Development mode

Vite hot-reload, tsx-watch for the backend, Caddy with `tls internal` — `./scripts/start.sh`
(mac) / `.\scripts\start.cmd` (Windows) does everything at once. Code changes appear
immediately in the browser.

For production (static frontend instead of Vite dev):

```bash
npm run build       # at repo root — runs vite build for the frontend
```

Then rewrite the Caddyfile to serve `frontend/dist/` as `root` (instead of proxying to
`:5173`), and remove the `frontend` process from the `Procfile` / `scripts/dev.mjs` list.

</details>
