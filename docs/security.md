# Security model

## Network
- Backend binds `127.0.0.1:7470` only. The only way in is `tailscale serve` (HTTPS, tailnet only) on port 7443.
- Ports used by other services on the machine go in `reservedPorts` (manar.json); the store never allocates them.

## Sign-in
- **Primary:** passkeys (WebAuthn, user verification required, discoverable credentials). RP ID = the host of `publicOrigin` (e.g. `my-server.tailnet.ts.net`).
- **Fallback:** password (scrypt N=2¹⁵) **and** TOTP (RFC 6238, ±1 step). A used TOTP step cannot be reused.
- **First run:** while no user exists the server writes a random token to `var/setup-token` (0600). Account creation needs that token, so it requires shell access on the server.
- Auth endpoints are rate-limited to 10 requests per minute per IP. Failed logins go to the `audit` table.

## Sessions
- Random 256-bit token in a `__Host-` cookie: `HttpOnly`, `Secure`, `SameSite=Strict`, 30 days. Only its SHA-256 hash is stored.
- CSRF: every non-GET `/api` request and every WebSocket upgrade must carry an `Origin` header matching the public origin.
- Users can list and revoke their signed-in devices.

## Dangerous actions
Two layers:
1. The UI asks "are you sure?". Deleting data also requires typing the app name.
2. The server requires a **step-up**. Routes guarded with `requireElevated` return `403 confirm_required` unless the session was confirmed with a passkey or TOTP in the last 5 minutes. The client then prompts and retries.

## Root access
- NovaOS runs as the service user chosen at install time. The only root path is `/usr/local/sbin/manar-helper` via a single `NOPASSWD` sudoers line. There is no open `sudo`.
- The helper allows exactly:
  - power: `reboot`, `poweroff`, `suspend`, `schedule reboot|poweroff <1–10080 min>`, `cancel-schedule`
  - services: `systemctl start|stop|restart <unit>`
  - processes: `kill TERM|KILL|HUP <pid>`
  - read-only: `smartctl <disk>`, `ports` (`ss -tulpn`), `ufw-status`
  - memory: `drop-caches` ("Release memory": `sync` then drop page cache, dentries and inodes)
  - drives: `mount-ext <partition>` / `umount-ext <partition>` (never the system disk; vfat/exfat/ext*/btrfs/xfs only; mounted `nosuid,nodev,noexec` under `/srv/data/external/<name>`; unmount only what NovaOS mounted; runs in the host mount namespace via `nsenter` so mounts are visible outside manar.service's private namespace; removable drives are auto-mounted on plug-in by a /proc/partitions watcher, and stale mounts of pulled-out drives are lazily detached)
  - apps: `ts-serve <20000–29999> on|off` (publish an app port on the tailnet), `rm-appdata <app-id>` (only `/srv/data/apps/<id>`, realpath-checked)
- Every argument is validated twice, in `server/src/helper.ts` and in the helper itself.
- Units that must never be stopped from the phone are refused: ssh, tailscaled, systemd-*, dbus, polkit, manar. Kernel threads and processes in those units cannot be killed.
- Each helper call is logged to syslog under the tag `manar-helper`.

## HTTP headers
CSP `default-src 'self'` (no inline scripts), `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`. API responses are `Cache-Control: no-store`, and the service worker never caches `/api`.

## Apps (Docker)
- Every app port is published as `127.0.0.1:<port>` (ports 20000–29999, never the reserved list) and reached via `tailscale serve` HTTPS on the same port number.
- Default passwords in catalog compose files are replaced with random secrets in `/srv/apps/<id>/.env` (0600).
- Catalog apps that need host networking, privileged mode or NVIDIA are excluded at build time. Apps that mount the Docker socket are flagged in the task log.
- Deleting an app's data needs a passkey/TOTP confirmation **and** typing the app id. The server checks the id again.

## Desktop windows and other apps on the server

- Desktop windows may frame only addresses on this server's tailnet name (`frame-src https://<host>:*`).
- Apps that forbid framing (Nova/OpenClaw, Infinity: `X-Frame-Options`/`frame-ancestors`) are **not** proxied
  around that protection; they open in a browser tab.
- Plain-http services of your own can be published as HTTPS on the tailnet with `tailscale serve` and listed in `var/services.json`.
- ArtCraft apps are served on their own origin (:7444) and allow framing only by NovaOS.
