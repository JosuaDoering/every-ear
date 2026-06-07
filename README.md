# Every Ear

Every Ear is a self-hosted tool for live audio translation at events. A translator speaks into a microphone; people in the room open a web page on their phone, pick a language, and listen. There is no app for guests to install, no account to create, and no internet connection required — everything runs on a single computer on the local network. There are some features that work better with an internet connection, but that is not required.

It ships as a desktop application for macOS and Windows. Guests connect from any device with a web browser.

## Features

- **Browser-based for guests and translators** — listeners and translators use a web page, no app needed.
- **Multiple languages per event** — one translator (and one audio channel) per language.
- **Runs locally** — audio stays on your network; no cloud service or internet access needed for a basic event.
- **Low latency** — typically under ~300 ms on a local network.
- **Optional trusted HTTPS** — use a self-signed certificate by default, or bring a real domain and a free Let's Encrypt certificate so guests see no browser warning. (This needs an internet connection.)

## Requirements

- A **Mac** or **Windows PC** to run the application (referred to as the *host*).
- A **local network** shared by everyone present. A wired (Ethernet) connection from the host to the router gives the most stable audio. No internet access is required for a basic event.
- A **microphone** for each translator. The phone's device might be sufficient. Bluetooth headphones are not recommended. 
- A **web browser** on each listener's device. Listener's can use bluetooth headphones. 

## Terminology

| Term | Meaning |
|------|---------|
| Host | The computer running the Every Ear application. |
| Translator | The person speaking a translation into a phone/microphone. |
| Listener | A guest listening on their own device. |
| Admin | The person configuring the event and generating translator codes. |
| Settings window | The application's control panel, opened from the menu bar/system tray. |

## Installation

1. Open the project's **Releases** page on GitHub and download the build for your system:
   - **macOS:** the `.dmg` file (`arm64` for Apple Silicon Macs, `x64` for Intel Macs).
   - **Windows 11:** the `Setup-….exe` file.
2. Install it:
   - **macOS:** open the `.dmg` and drag **Every Ear** into **Applications**.
   - **Windows:** run the installer and follow the prompts.

### Unsigned builds

The current releases are not code-signed, so the operating system shows a warning on first launch:

- **macOS:** right-click the app in **Applications**, choose **Open**, then **Open** again. Subsequent launches work normally.
- **Windows:** on the SmartScreen prompt, click **More info → Run anyway**.

## Usage

### First launch

On first launch, Every Ear generates an admin password and shows it once. Copy it and store it somewhere safe. It is used to manage events. The application then runs from the menu bar (macOS) or system tray (Windows). Click its icon to open the **Settings window**.

The admin password can be changed later in the Settings window under **Admin Password**.

### Running an event

1. Connect the host to the event network (Ethernet recommended and WiFi turned off) and to power.
2. Open the Settings window. Under **Connection** you'll find the **listener URL** and a QR code. If the host has more than one network, pick the right one from the **Network interface** dropdown, or leave it on **Auto**.
3. Share the listener URL or QR code with your guests (e.g. on a screen or printout).
4. Generate a code for each translator: click **Open admin** in the app menu (or open the listener URL and append `/admin.html`), log in with the admin password, then create a code by choosing an event, a language, and a name. Events and languages are also managed here.

Translators open the translator URL via the QR code (or manually: listener URL with `/translator.html` appended), enter their 6-digit code, and allow microphone access when prompted.

Listeners open the listener URL (or scan the QR code), choose an event and language, and press play. On iOS, audio only starts after a tap, due to browser policy. The first time a device connects it may show a certificate warning (see below).

## HTTPS and custom domain

By default Every Ear serves listeners over HTTPS using a self-signed certificate. The connection is encrypted, but because the certificate is not issued by a recognized authority, browsers show a one-time "not secure" warning that guests dismiss with **Advanced → proceed anyway**. For many events this is sufficient and no further setup is needed.

To remove the warning, point a domain you own at the host and use a trusted certificate. This section explains the concepts and the options.

### How DNS fits in

DNS maps human-readable names (e.g. `events.example.com`) to IP addresses (e.g. `192.168.1.50`). That's like an address book that maps the family name to the address where that family resides. You manage DNS for a domain through the provider you registered it with, by editing **DNS records**. 

Two record types are relevant here:

| Record | Example | Purpose |
|--------|---------|---------|
| **A record** | `events.example.com → 192.168.1.50` | Points the name at the host's IP address on the event network, so the name reaches Every Ear. |
| **TXT record** | `_acme-challenge.events.example.com → <random value>` | A temporary proof of domain ownership that Let's Encrypt checks before issuing a certificate. It needs to be added for the ownership validation and can be removed after the certificate has been issued. |

For a local event, the A record points at the host's address on the event network (often a private address such as `192.168.x.x` or `10.x.x.x`), so the name only resolves for guests on that same network. The trusted certificate still works regardless, because. Let's Encrypt validates ownership through the TXT record and never needs to reach the host directly.

### Registering a domain

A domain is required for trusted HTTPS, and registration is inexpensive (commonly a few euros per year). Every Ear includes a built-in integration with **Netcup's** DNS API: after you enter a Netcup API key once, the application can issue the certificate and update the A record without manual action. Any other DNS provider works too — you create the records yourself using the application's manual guide (see *Other providers*).

### Setting it up

Open the Settings window. The **Certificate** tab covers the certificate itself, the **DNS** tab shows the record your domain needs and has the A-record update button, and the **Netcup** tab holds the Netcup API credentials. On the **Certificate** tab, enter your domain (e.g. `events.example.com`) in the **Domain** field, then choose an approach.

#### Let's Encrypt (free, trusted)

On the **Certificate** tab, select **Let's Encrypt** and pick a DNS provider.

- **Netcup (automatic):** First, on the **Netcup** tab, enter your Netcup **Customer ID**, **API Key**, and **API Password** (created in the Netcup control panel under *Master data → API*). Then, on the **DNS** tab, click **Update A-record to this computer's IP** to point the domain at the host. Finally, on the **Certificate** tab, choose **Netcup** and click **Get certificate**. The app creates the validation record, waits for it to propagate, completes validation, installs the certificate, and removes the record.
- **Other / manual:** The app shows the exact A and TXT records to create. Add the A record in your provider, click **Get certificate**, then add the TXT record it displays. Every Ear polls public DNS and finishes automatically once the record is visible (up to about ten minutes). The TXT record can be deleted afterwards.

#### Own certificate

If you already have a certificate (from your provider, your IT department, or a tool such as [Certbot](https://certbot.eff.org/) or [acme.sh](https://github.com/acmesh-official/acme.sh)), open the **Own Certificate** tab, select the PEM-encoded `cert.pem` and `key.pem` files, and click **Save & restart**. Point the A record at the host yourself; the **DNS** tab shows the required record. Use **Reset to internal CA** to return to the default self-signed setup.

### Other providers

The automatic path currently supports Netcup. With any other provider, use the **Other / manual** option for a free Let's Encrypt certificate, or supply your own certificate via the **Own Certificate** tab. The manual option works with any DNS provider.

## Troubleshooting

| Symptom | Resolution |
|---------|------------|
| A listener hears nothing | Tap play again. On iOS, audio only starts after a tap. |
| The translator's microphone doesn't work | Allow microphone access for the browser. macOS: System Settings → Privacy & Security → Microphone. Windows: Settings → Privacy & security → Microphone. |
| A device shows a security warning | Tap **Advanced → proceed anyway** (first connection only), or set up a trusted certificate (see *HTTPS and custom domain*). |
| The Connection address shows "—" | The host is not on a usable network. Reconnect, click **Rescan**, and select the correct interface. |
| "Firewall is blocking livekit-server" (macOS) | Use the banner's **Open Firewall settings**, allow incoming connections for `livekit-server`, then **Re-check**. The banner's info button explains the details. |
| Audio drops out | The network is likely overloaded. Use Ethernet between the host and the router and ensure the network can handle the number of listeners. |
| The host's IP changed and the domain stopped working | Update the A record to the new IP. With Netcup, open the **DNS** tab and click **Update A-record to this computer's IP**. |

If a problem persists, quit Every Ear completely, reopen it, and run the event setup again.

### Logs and data

The Settings window's **Advanced** section can reveal the log folder, regenerate the internal LiveKit credentials, and reset all data (events, codes, languages, backgrounds, and credentials — this cannot be undone).

Application data is stored at:

- **macOS:** `~/Library/Application Support/every-ear/`
- **Windows:** `%APPDATA%\every-ear\`

## Development

### Architecture

Every Ear is built on LiveKit (a WebRTC SFU) for media, a Node + Fastify backend for token issuance, a Vite + vanilla-TypeScript frontend, Caddy as the HTTPS proxy, and an Electron wrapper for the desktop application.

### Authentication

- **Listeners** receive an anonymous, subscribe-only JWT scoped to one event-and-language room.
- **Translators** exchange a 6-digit code for a publish JWT scoped to one event/language, carrying their display name.
- **Admin** access uses a bearer token derived from the admin password. Events, codes, languages, and uploaded backgrounds are stored in the application's data directory.
- The LiveKit API key and secret remain on the server; the frontend only ever receives short-lived JWTs.

### Building the desktop app

```bash
npm run install:all          # install backend/, frontend/, and desktop/ dependencies
npm run desktop:dist:mac     # → desktop/dist/Every Ear-1.0.0-arm64.dmg + -x64.dmg
npm run desktop:dist:win     # → desktop/dist/Every Ear-Setup-1.0.0.exe
npm run desktop:dev          # build and launch Electron against the live source
```

The `dist:*` scripts download pinned LiveKit and Caddy binaries into `desktop/resources/bin/<os>/<arch>/` and bundle them as Electron extra-resources. Dev mode falls back to PATH-resolved `livekit-server` / `caddy`. Release builds are unsigned; add signing identities to `desktop/electron-builder.yml` to change that.

### ACME / DNS-01 internals

Certificates are obtained via the Let's Encrypt **DNS-01** challenge (`desktop/src/acme-manager.ts`). The challenge TXT record is written through a provider API (`desktop/src/netcup-dns.ts`), public resolvers (1.1.1.1 / 8.8.8.8) are polled until the record is visible, the challenge is completed, and `cert.pem` / `key.pem` are installed. `ensureARecord` updates the domain's A record to the host's current LAN IP. DNS-01 is used because it does not require the host to be publicly reachable.

Adding another automated provider means implementing the same surface as `netcup-dns.ts` (login, add/remove TXT, ensure A) and wiring it into the settings UI; the propagation poller in `acme-manager.ts` is provider-agnostic.

### Running from source

Plain scripts run the stack directly (Vite hot-reload, tsx-watch backend, Caddy with `tls internal`):

- macOS: `./scripts/install-mac.sh`, then `./scripts/start.sh` and `./scripts/show-url.sh`
- Windows: `.\scripts\install-windows.cmd`, then `.\scripts\start.cmd` and `.\scripts\show-url.cmd`

Set `ADMIN_PASSWORD` and the `LANGUAGES` / `LANGUAGE_NAMES` / `LANGUAGE_FLAGS` seed values in `.env`. After first boot, the language list is stored in `backend/data/languages.json` and the seed variables are ignored.

For a static production frontend instead of the Vite dev server:

```bash
npm run build       # vite build for the frontend
```

Then serve `frontend/dist/` as Caddy's `root` and remove the `frontend` process from `Procfile` / `scripts/dev.mjs`.

### Load testing

```bash
livekit-cli load-test \
  --url ws://127.0.0.1:7880 \
  --api-key "$LIVEKIT_API_KEY" --api-secret "$LIVEKIT_API_SECRET" \
  --room event-<id>-lang-en --subscribers 200 --duration 60s
```

As a bandwidth estimate, 500 listeners at ~50 kbit/s is roughly 25 Mbit/s; use Ethernet between the host and the wireless access points.

## License

Released under the [MIT License](LICENSE).