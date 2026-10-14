# NovaOS

**Turn a mini PC into a home server you run from your phone.**

NovaOS is a mobile-first web app (and an Android app) that manages a Linux box end to end:
files and photos, a media library, an app store of self-hosted services, retro-game streaming,
backups, monitoring and power, all behind Tailscale with passkey sign-in. One installer, one
setup wizard, updates from GitHub Releases with rollback.

<p align="center">
  <img src="docs/brand/preview-1024.png" alt="NovaOS on a phone" width="720">
</p>

## What you get

- **Files**: browse every drive, upload, preview Office/CAD/PDF, extract archives, a trash per drive, share links (password, expiry) and upload links anyone can drop files into, with upload hardening.
- **Gallery and Music**: photos and audio from your drives with thumbnails, playlists and a mini player.
- **Watch**: a Jellyfin-style library (continue watching, next up, latest), auto-sorting of downloads into Movies/Series, subtitle fetching.
- **Store**: one-tap install of self-hosted apps (Jellyfin, Immich, qBittorrent, Paperless, Uptime Kuma, AdGuard, Vaultwarden, …), each published on your tailnet only, credentials kept for you, app updates checked daily.
- **Games**: ROMs streamed to any TV or phone with Sunshine + Moonlight, an always-on EmulationStation, covers, favorites, save restore and launch-from-phone.
- **Downloads**: paste any link (direct, YouTube/yt-dlp, torrent) and it lands on the big drive.
- **Backup**: nightly restic snapshots of your data and app configs, with browse and restore.
- **Health, Monitor, Network, Docker, Processes, Updates, Power**: the whole machine from one screen, including SMART, temperatures, Tailscale peers, system packages, and a self-update of NovaOS from GitHub Releases with rollback.
- **Desktop mode**: on a laptop or TV browser it becomes a window manager with a dock and widgets.
- **Android app**: phones and Android TV; notifications from the server, "share to server" from any app, fingerprint lock.
- **Arabic and English**, right-to-left done properly.

## Install

One line on a fresh Debian or Ubuntu machine (an existing one works too). It installs Node.js,
Docker, Tailscale and the service, then prints the address and a one-time setup token:

```sh
curl -fsSL https://raw.githubusercontent.com/anasshadid93/NovaOS/main/deploy/get.sh | sudo bash
```

Open the printed address on your phone and enter the token. The setup wizard asks for the server
name, address, time zone and big drive, creates your account (password + authenticator, then a
passkey) and sends you to the Store. Running the same line again updates an existing install.

Options and the manual route: [docs/install.md](docs/install.md).

## How it works

```
phone / TV / laptop ──HTTPS (tailscale serve :7443)──▶ 127.0.0.1:7470  server/  Fastify + TypeScript
                                                              │            web/     React PWA served by the server
                                                              ├─ sudo ──▶ manar-helper   the only root path (allow-listed commands)
                                                              ├─ docker ─▶ Store apps     /srv/data/apps/<id>
                                                              └─ /srv/data, mounted drives, restic, ffmpeg, 7z …
```

- `server/` Fastify + TypeScript, SQLite, listens on localhost only.
- `web/` React + Vite + Tailwind PWA.
- `android/` Kotlin WebView shell with notifications (ntfy) and share targets.
- `deploy/` installer, systemd unit, root helper and sudoers rule; `.github/` the release workflow.
- `docs/` install and security notes, screenshots.
- `ops/` the author's game-streaming stack (Sunshine + ES-DE) as a worked example.

Configuration lives in `var/manar.json` (see `manar.example.json`); `MANAR_*` environment variables
override it. Optional integrations (Telegram bot, an n8n assistant webhook, WhatsApp alerts, a bot API
for automations, ERP lookups, a paper-trading bot) switch themselves on only when configured.
Settings → Integrations shows what is on and what each one needs.

## Security in one paragraph

Nothing listens on the LAN or the internet except what you publish. Sign-in is passkeys first,
password + TOTP as fallback, and the very first account needs a one-time token from the server's disk.
Sessions are `__Host-` cookies with origin (CSRF) checks, and dangerous actions need a fresh
passkey/TOTP step-up. The app never has open sudo: one root helper with an allow-list, installed with
`visudo` validation. Public share and upload links run on a separate server you can put behind a
reverse proxy, with file-type and size limits. Full notes: [docs/security.md](docs/security.md).

## Develop

```sh
npm ci
npm run build                            # web + server
npm test                                 # server and web tests
MANAR_DEV=1 node server/dist/index.js    # dev mode: plain-http cookie, localhost origins
npm run dev:web                          # Vite on 127.0.0.1:5173, proxies /api to :7470
```

Releases: tag `vX.Y.Z` and push the tag. The workflow runs the tests, builds and signs the Android
APK from repository secrets, and publishes a GitHub Release; installs pick it up in Settings → Updates.

## License

MIT. Built by Anas Shadid for his own mini PC first, then made portable so it can run on yours.
