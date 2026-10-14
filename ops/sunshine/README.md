# Game streaming: Sunshine (replaced Wolf on 2026-10-14)

Wolf gave black screens on the TV and slow starts (a new container per session). Now:

- `manar-games-esde` (ghcr.io/games-on-whales/es-de:edge): sway **headless** 1920x1080 + ES-DE, always running
  (`sway.config` mounted over /cfg/sway/config: no bar, everything fullscreen). Home = /srv/data/apps/sunshine/home
  (copied from the Wolf client home: Art Book NEXT theme, libretro cores, PCSX2/shadPS4 setup). ROMs/bios/media from the Toshiba.
- `manar-games-sunshine` (manar/sunshine:local = lizardbyte/sunshine:latest-ubuntu-24.04 + mesa-va-drivers): wlr screen capture
  of the sway socket, VA-API H.264/HEVC/AV1 on renderD128, virtual gamepads/keyboard via /dev/uinput. HOME=/sunhome
  (the image's /config is a symlink into a private home). Waits for the Wayland socket before starting.
  Config in /srv/data/apps/sunshine/config/.config/sunshine (copies here, credentials not in git; admin login in
  var/apps-credentials.json `sunshine`). `system_tray = disabled` is required, otherwise the main loop exits in a container.
- `manar-games-pulse`: PulseAudio for both (socket /srv/data/apps/sunshine/run/pulse).
- The TV (Android TV Moonlight) shows BLACK with HEVC from the 890M (both Wolf and Sunshine); software decode is fine. So hevc_mode=1 + av1_mode=1 → H.264 only.
- Pairing: NovaOS → Games → type the PIN Moonlight shows (server/src/games/games.ts → Sunshine /api/pin with pairing_id).
- Wolf: /srv/data/apps/wolf (stopped, restart=no, configs kept in /etc/wolf for rollback).
- **DANGER fixed 2026-10-14:** the es-de image's /etc/cont-init.d/10-setup_user.sh runs `userdel -r` when uid 1000 already
  exists — i.e. on every restart of the same container — wiping the bind-mounted home AND anything mounted inside it
  (it erased Games/bios on the Toshiba and the RetroArch cores). `10-setup_user.sh` here (mounted ro over the original)
  keeps the existing user; the bios mounts are now read-only. Bios were rebuilt from the torrents in Downloads/Torrents,
  archive.org 11.00 sys_modules and Sony's PS3UPDAT.PUP. (Wolf never hit this: it creates a fresh container per session.)
