#!/bin/bash
# Installs NovaOS's system pieces from an already built checkout. Run as root:
#   sudo deploy/install.sh [--user NAME] [--data-root DIR] [--port N] [--https-port N] [--no-tailscale]
#   1. /usr/local/sbin/manar-helper   (root:root 0755; the only command the app may run as root)
#   2. /etc/sudoers.d/manar           (validated with visudo before it goes live)
#   3. /etc/systemd/system/manar.service
#   4. <data-root>/{apps,files,external}, owned by the service user
#   5. tailscale serve https:<https-port> -> http://127.0.0.1:<port> (tailnet only), unless --no-tailscale
# Any existing file is backed up to /var/backups/manar/<timestamp>/ first.
# `sudo deploy/install.sh --uninstall` removes 1-3 and the serve entry; data is kept.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPLOY=$ROOT/deploy
USER_NAME=${MANAR_USER:-${SUDO_USER:-}}
DATA_ROOT=${MANAR_DATA_ROOT:-/srv/data}
PORT=${MANAR_PORT:-7470}
TS_PORT=${MANAR_HTTPS_PORT:-7443}
TAILSCALE=1
UNINSTALL=0
BACKUP=/var/backups/manar/$(date +%Y%m%d-%H%M%S)

while [[ $# -gt 0 ]]; do
  case "$1" in
    --user) USER_NAME=$2; shift 2 ;;
    --data-root) DATA_ROOT=$2; shift 2 ;;
    --port) PORT=$2; shift 2 ;;
    --https-port) TS_PORT=$2; shift 2 ;;
    --no-tailscale) TAILSCALE=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    -h|--help) sed -n 2,10p "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

backup() {
  if [[ -e $1 ]]; then
    mkdir -p "$BACKUP"
    cp -a "$1" "$BACKUP/"
    echo "backed up $1 -> $BACKUP/"
  fi
}

if [[ $UNINSTALL -eq 1 ]]; then
  systemctl disable --now manar.service 2>/dev/null || true
  if command -v tailscale >/dev/null; then tailscale serve --https="$TS_PORT" off 2>/dev/null || true; fi
  for f in /etc/systemd/system/manar.service /etc/sudoers.d/manar /usr/local/sbin/manar-helper; do
    backup "$f"
    rm -f "$f"
  done
  systemctl daemon-reload
  echo "NovaOS uninstalled (data in $ROOT/var and $DATA_ROOT kept)."
  exit 0
fi

[[ -n $USER_NAME && $USER_NAME != root ]] || { echo "pass --user NAME (the non-root user the service runs as)" >&2; exit 1; }
id -u "$USER_NAME" >/dev/null 2>&1 || { echo "no such user: $USER_NAME" >&2; exit 1; }
[[ $USER_NAME =~ ^[a-z_][a-z0-9_-]{0,31}$ ]] || { echo "user name must be a plain unix name" >&2; exit 1; }
[[ $DATA_ROOT == /* && $DATA_ROOT != *[[:space:]]* ]] || { echo "data root must be an absolute path" >&2; exit 1; }
[[ $PORT =~ ^[0-9]{2,5}$ && $TS_PORT =~ ^[0-9]{2,5}$ ]] || { echo "ports must be numbers" >&2; exit 1; }
GROUP_NAME=$(id -gn "$USER_NAME")
UID_NUM=$(id -u "$USER_NAME")
GID_NUM=$(id -g "$USER_NAME")

[[ -f $ROOT/server/dist/index.js && -f $ROOT/web/dist/index.html ]] || {
  echo "build first: npm ci && npm run build (as $USER_NAME)" >&2
  exit 1
}
if ss -ltnH "sport = :$PORT" | grep -q . && ! systemctl is-active -q manar.service; then
  echo "port $PORT is already in use by something else" >&2
  exit 1
fi

fill() {
  sed -e "s#@ROOT@#$ROOT#g" -e "s#@USER@#$USER_NAME#g" -e "s#@GROUP@#$GROUP_NAME#g" \
      -e "s#@UID@#$UID_NUM#g" -e "s#@GID@#$GID_NUM#g" -e "s#@DATA_ROOT@#$DATA_ROOT#g" -e "s#@PORT@#$PORT#g" "$1"
}

# 1. helper
backup /usr/local/sbin/manar-helper
tmp=$(mktemp)
fill "$DEPLOY/manar-helper" >"$tmp"
bash -n "$tmp"
install -o root -g root -m 0755 "$tmp" /usr/local/sbin/manar-helper
rm -f "$tmp"

# 2. sudoers — validate a temp copy before installing
tmp=$(mktemp)
fill "$DEPLOY/sudoers.manar" >"$tmp"
chown root:root "$tmp"; chmod 0440 "$tmp"
visudo -cf "$tmp"
backup /etc/sudoers.d/manar
mv "$tmp" /etc/sudoers.d/manar
visudo -c >/dev/null

# 3. systemd unit
backup /etc/systemd/system/manar.service
fill "$DEPLOY/manar.service.in" >/etc/systemd/system/manar.service
chmod 0644 /etc/systemd/system/manar.service
systemd-analyze verify /etc/systemd/system/manar.service
systemctl daemon-reload

# 4. data folders (they need root once; the app never creates them itself)
for d in "$DATA_ROOT" "$DATA_ROOT/apps" "$DATA_ROOT/files" "$DATA_ROOT/external"; do
  [[ -d $d ]] || mkdir -p -m 0755 "$d"
done
chown "$USER_NAME:$GROUP_NAME" "$DATA_ROOT/apps" "$DATA_ROOT/files"
# Non-default data root: tell the app (the helper has it baked in above).
if [[ $DATA_ROOT != /srv/data ]]; then
  mkdir -p "$ROOT/var"
  cfg=$ROOT/var/manar.json
  [[ -f $cfg ]] || echo '{}' >"$cfg"
  node -e 'const fs=require("fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));c.dataRoot=process.argv[2];fs.writeFileSync(f,JSON.stringify(c,null,2)+"\n")' "$cfg" "$DATA_ROOT"
  chown -R "$USER_NAME:$GROUP_NAME" "$ROOT/var"
fi
# The store needs the docker socket.
if getent group docker >/dev/null && ! id -nG "$USER_NAME" | tr ' ' '\n' | grep -qx docker; then
  usermod -aG docker "$USER_NAME"
  echo "added $USER_NAME to the docker group"
fi

systemctl enable --now manar.service

# 4a. Quant Desk agents sidecar (optional): TradingAgents venv + server.py (see docs/quant.md).
if [[ -f $DATA_ROOT/apps/tradingagents/server.py && -x $DATA_ROOT/apps/tradingagents/venv/bin/python ]]; then
  backup /etc/systemd/system/novaos-agents.service
  fill "$DEPLOY/novaos-agents.service.in" >/etc/systemd/system/novaos-agents.service
  chmod 0644 /etc/systemd/system/novaos-agents.service
  systemctl daemon-reload
  systemctl enable --now novaos-agents.service
fi

# 4b. vision sidecar (optional): only when its models and venv are in place (see docs/vision.md).
if [[ -f $DATA_ROOT/apps/vision/server.py && -x $DATA_ROOT/apps/vision/venv/bin/python ]]; then
  backup /etc/systemd/system/novaos-vision.service
  fill "$DEPLOY/novaos-vision.service.in" >/etc/systemd/system/novaos-vision.service
  chmod 0644 /etc/systemd/system/novaos-vision.service
  systemctl daemon-reload
  systemctl enable --now novaos-vision.service
fi

# 5. tailscale serve (adds one port; existing serve entries are untouched)
URL="https://$(hostname):$TS_PORT"
if [[ $TAILSCALE -eq 1 ]] && command -v tailscale >/dev/null && tailscale status >/dev/null 2>&1; then
  tailscale serve --bg --https="$TS_PORT" "http://127.0.0.1:$PORT" >/dev/null
  dns=$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1)
  [[ -n $dns ]] && URL="https://$dns:$TS_PORT"
elif [[ $TAILSCALE -eq 1 ]]; then
  echo "tailscale is not running: the app only listens on 127.0.0.1:$PORT. Install Tailscale (https://tailscale.com/download)"
  echo "and run 'sudo tailscale serve --bg --https=$TS_PORT http://127.0.0.1:$PORT', or put your own HTTPS reverse proxy in front."
fi

echo
echo "NovaOS is running: $URL"
for _ in $(seq 1 20); do [[ -f $ROOT/var/setup-token ]] && break; sleep 0.5; done
if [[ -f $ROOT/var/setup-token ]]; then
  echo "First-run setup token: $(cat "$ROOT/var/setup-token")"
  echo "Open the address above on your phone and enter the token; the wizard does the rest."
fi
