# LocalLingua

Self-hosted live translation for large events. Translators stream audio from the browser, listeners open a website and press ▶︎ — no registration, no app. Target latency in LAN: < 300 ms.

Stack: LiveKit (WebRTC-SFU) · Node + Fastify (Tokens) · Vite + Vanilla TS (Frontend) · Caddy (HTTPS-Proxy). Everything runs on a Mac/PC in the event LAN.

## First Setup

```bash
./scripts/install-mac.sh    # Install Homebrew packages + npm install + create .env
$EDITOR .env                # Set ADMIN_PASSWORD, adjust languages
```

## Event Day

1. Connect host to the event network via **Ethernet (USB-C adapter)**, connect **power**.
2. `./scripts/start.sh` — starts LiveKit, backend, frontend, Caddy. Asks once for `sudo` (for port 443), then `caffeinate` keeps the system awake.
3. Admin: Open `https://<lan-ip>/admin.html`, log in with `ADMIN_PASSWORD`, generate **a code for each translator** (Language + Name → 6-digit code).
4. In another terminal: `./scripts/show-url.sh` — shows URL + QR code for the listeners.
5. Translators open `https://<lan-ip>/translator.html`, enter **only the code**, click connect.

## What the Listeners Do

1. Open website, accept certificate once (Caddy `tls internal`, no internet needed).
2. Choose language (with flag), press ▶ — done.
3. As soon as the translator broadcasts, "🇬🇧 Anna is translating for you" appears.

## How Auth Works

- **Listeners**: Backend anonymously issues a subscribe-only JWT to everyone for exactly one room.
- **Translators**: Code (6-digit) → Backend verifies + issues a publish JWT with name & language from the code entry.
- **Admin**: Bearer token against `ADMIN_PASSWORD`. Codes are persisted in `backend/data/codes.json` (survives restarts).
- LiveKit API key/secret remain on the server; the frontend only gets short-lived JWTs.

## Changing Languages

In `.env`:
```
LANGUAGES=en,fr,es,de
LANGUAGE_NAMES='{"en":"English","fr":"Français","es":"Español","de":"Deutsch"}'
# Optional, otherwise defaults per ISO code:
LANGUAGE_FLAGS='{"en":"🇬🇧🇺🇸"}'
```

Restart backend (`Ctrl+C` and `start.sh` again, or in the overmind terminal `overmind restart backend`).

## Changing the Background Image

In the admin UI (`/admin.html`) → "Background image" block → choose file → Upload. Fallback is `frontend/public/bg.jpg`. Reset button restores the default.

## Testing Latency

In a second terminal:

```bash
livekit-cli load-test \
  --url ws://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room lang-en --subscribers 200 --duration 60s
```

Target on M-series: < 30% CPU, smooth audio with 200+ subscribers.

## Troubleshooting

- **Listener hears nothing** → tap ▶︎ again. On iOS, audio only starts after a touch (browser policy).
- **"Microphone access denied"** for the translator → macOS System Settings ▸ Privacy ▸ Microphone → allow browser. Browser additionally needs HTTPS — `localhost` and Caddy's internal CA are both OK.
- **Listener device cannot connect** → Accept Caddy's cert (Browser warning "Advanced ▸ proceed anyway"). Alternatively, distribute the Caddy root once: `cat ~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt`.
- **Audio drops out** → Event Wi-Fi has too little bandwidth. For 500 listeners × 50 kbit/s = 25 Mbit/s. Use Ethernet between MacBook and Wi-Fi access points, do not connect the Mac itself via Wi-Fi.
- **"Address already in use"** → Ports 443, 3000, 5173, 7880, 7881, 7882 must be free. `lsof -nP -iTCP:443 -sTCP:LISTEN` shows the blocker.

## Development Mode

Vite Hot-Reload, tsx-Watch for the backend, Caddy with `tls internal` — `./scripts/start.sh` does everything at once. Code changes appear immediately in the browser.

For production (static frontend instead of Vite-Dev):

```bash
cd frontend && npm run build
```

Rewrite Caddyfile so that it serves `frontend/dist/` as `root` (instead of proxy to `:5173`), and remove the `frontend` process from the `Procfile`.