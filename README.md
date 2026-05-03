# LocalLingua

Selbst gehostete Live-Übersetzung für Großevents. Übersetzer streamen Audio aus dem Browser, Hörer öffnen eine Webseite und drücken auf ▶︎ — keine Anmeldung, keine App. Ziel-Latenz im LAN: < 300 ms.

Stack: LiveKit (WebRTC-SFU) · Node + Fastify (Tokens) · Vite + Vanilla TS (Frontend) · Caddy (HTTPS-Proxy). Alles läuft auf einem MacBook im Event-LAN.

## Erstes Setup

```bash
./scripts/install-mac.sh    # Homebrew-Pakete + npm install + .env anlegen
$EDITOR .env                # ADMIN_PASSWORD setzen, Sprachen anpassen
```

## Eventtag

1. MacBook per **Ethernet (USB-C-Adapter)** ans Event-Netz, **Strom** anschließen.
2. `./scripts/start.sh` — startet LiveKit, Backend, Frontend, Caddy. Fragt einmal nach `sudo` (für Port 443), dann `caffeinate` hält das System wach.
3. Admin: `https://<lan-ip>/admin.html` öffnen, mit `ADMIN_PASSWORD` einloggen, **für jeden Übersetzer einen Code** generieren (Sprache + Name → 6-stelliger Code).
4. In einem anderen Terminal: `./scripts/show-url.sh` — zeigt URL + QR-Code für die Hörer.
5. Übersetzer öffnen `https://<lan-ip>/translator.html`, geben **nur den Code** ein, klicken Verbinden.

## Was die Hörer machen

1. Webseite öffnen, Zertifikat einmal akzeptieren (Caddy `tls internal`, kein Internet nötig).
2. Sprache (mit Flagge) wählen, ▶ drücken — fertig.
3. Sobald der Übersetzer broadcastet, erscheint „🇬🇧 Anna is translating for you".

## Wie die Auth läuft

- **Hörer**: Backend gibt jedem anonym ein subscribe-only-JWT für genau einen Raum.
- **Übersetzer**: Code (6-stellig) → Backend prüft + gibt publish-JWT mit Name & Sprache aus dem Code-Eintrag.
- **Admin**: Bearer-Token gegen `ADMIN_PASSWORD`. Codes werden in `backend/data/codes.json` persistiert (überlebt Restarts).
- LiveKit-API-Key/Secret bleiben auf dem Server; das Frontend bekommt nur kurzlebige JWTs.

## Sprachen ändern

In `.env`:

```
LANGUAGES=en,fr,es,de
LANGUAGE_NAMES='{"en":"English","fr":"Français","es":"Español","de":"Deutsch"}'
# Optional, sonst Defaults pro ISO-Code:
LANGUAGE_FLAGS='{"en":"🇬🇧🇺🇸"}'
```

Backend neu starten (`Ctrl+C` und `start.sh` erneut, oder im overmind-Terminal `overmind restart backend`).

## Hintergrundbild ändern

In der Admin-UI (`/admin.html`) → Block „Background image" → Datei wählen → Upload. Fallback ist `frontend/public/bg.jpg`. Reset-Button stellt das Default wieder her.

## Latenz testen

In einem zweiten Terminal:

```bash
livekit-cli load-test \
  --url ws://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room lang-en --subscribers 200 --duration 60s
```

Ziel auf M-Serie: < 30 % CPU, glatter Audio-Verlauf bei 200+ Subscribern.

## Troubleshooting

- **Hörer hört nichts** → ▶︎ erneut tippen. Auf iOS startet Audio erst nach Touch (Browser-Policy).
- **„Mikrofon-Zugriff verweigert"** beim Übersetzer → macOS-Systemeinstellungen ▸ Datenschutz ▸ Mikrofon → Browser zulassen. Browser braucht zusätzlich HTTPS — `localhost` und Caddys interne CA sind beide OK.
- **Hörer-Gerät kann sich nicht verbinden** → Caddys Cert akzeptieren (Browser-Warnung „Erweitert ▸ trotzdem fortfahren"). Alternativ den Caddy-Root einmal verteilen: `cat ~/Library/Application\ Support/Caddy/pki/authorities/local/root.crt`.
- **Audio bricht ab** → Event-WLAN hat zu wenig Bandbreite. Bei 500 Hörern × 50 kbit/s = 25 Mbit/s. Ethernet zwischen MacBook und WLAN-Access-Points nutzen, nicht das Mac selbst per WLAN.
- **„Address already in use"** → Ports 443, 3000, 5173, 7880, 7881, 7882 müssen frei sein. `lsof -nP -iTCP:443 -sTCP:LISTEN` zeigt den Blocker.

## Entwicklungs-Modus

Vite Hot-Reload, tsx-Watch fürs Backend, Caddy mit `tls internal` — `./scripts/start.sh` macht alles auf einmal. Code-Änderungen erscheinen sofort im Browser.

Für Produktion (statisches Frontend statt Vite-Dev):

```bash
cd frontend && npm run build
```

Caddyfile so umschreiben, dass es `frontend/dist/` als `root` serviert (statt Proxy auf `:5173`), und das `frontend`-Process aus dem `Procfile` entfernen.
