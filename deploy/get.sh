#!/bin/bash
# NovaOS one-line installer for Debian/Ubuntu (systemd). Run as root:
#   curl -fsSL https://raw.githubusercontent.com/anasshadid93/NovaOS/main/deploy/get.sh | sudo bash
# Options (environment variables):
#   MANAR_USER=name        service user (default: the user who ran sudo, else a new system user "manar")
#   MANAR_DIR=/opt/novaos   where the code lives (default: /opt/novaos)
#   MANAR_DATA_ROOT=/srv/data     your files, apps data and mounted drives (default: /srv/data)
#   MANAR_REPO=url|path    git source (default: GitHub); a local path is copied instead of cloned
#   MANAR_REF=main         branch or tag to install (default: main)
#   MANAR_NO_DOCKER=1      skip installing Docker (the Store needs it; everything else works without)
#   MANAR_NO_TAILSCALE=1   skip installing Tailscale (you will need your own HTTPS reverse proxy)
#   MANAR_NO_SERVICE=1     stop after building (no system changes; used for tests)
# Re-running updates an existing install in place (git pull, rebuild, restart).
set -euo pipefail

REPO=${MANAR_REPO:-https://github.com/anasshadid93/NovaOS.git}
REF=${MANAR_REF:-main}
DIR=${MANAR_DIR:-/opt/novaos}
DATA_ROOT=${MANAR_DATA_ROOT:-/srv/data}
USER_NAME=${MANAR_USER:-${SUDO_USER:-}}
NODE_MAJOR=22

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "run as root: curl -fsSL <url> | sudo bash"
[[ -r /etc/os-release ]] || die "unsupported system (no /etc/os-release)"
. /etc/os-release
case "${ID:-} ${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) die "only Debian/Ubuntu are supported by this script (found ${PRETTY_NAME:-unknown}). See docs/install.md for the manual steps." ;;
esac
[[ -d /run/systemd/system || -n ${MANAR_NO_SERVICE:-} ]] || die "systemd is required"
[[ $(uname -m) =~ ^(x86_64|aarch64)$ ]] || die "unsupported CPU: $(uname -m)"

export DEBIAN_FRONTEND=noninteractive
apt_install() {
  local missing=()
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p"); done
  [[ ${#missing[@]} -eq 0 ]] || { say "installing ${missing[*]}"; apt-get install -y -q "${missing[@]}"; }
}

# ---- 1. service user --------------------------------------------------------
if [[ -z $USER_NAME || $USER_NAME == root ]]; then
  USER_NAME=manar
  if ! id -u manar >/dev/null 2>&1; then
    say "creating system user manar"
    useradd --system --create-home --home-dir /var/lib/manar --shell /usr/sbin/nologin manar
  fi
fi
id -u "$USER_NAME" >/dev/null 2>&1 || die "no such user: $USER_NAME"
GROUP_NAME=$(id -gn "$USER_NAME")
say "service user: $USER_NAME"

# ---- 2. packages ------------------------------------------------------------
say "refreshing package lists"
apt-get update -q
apt_install ca-certificates curl git gnupg rsync util-linux build-essential python3 p7zip-full ffmpeg restic smartmontools lm-sensors

if ! command -v node >/dev/null || [[ $(node -p 'process.versions.node.split(".")[0]') -lt $NODE_MAJOR ]]; then
  say "installing Node.js $NODE_MAJOR (NodeSource)"
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" >/etc/apt/sources.list.d/nodesource.list
  apt-get update -q
  apt-get install -y -q nodejs
fi
say "node $(node -v), npm $(npm -v)"

if [[ -z ${MANAR_NO_DOCKER:-} ]] && ! command -v docker >/dev/null; then
  say "installing Docker (docker.io + compose)"
  apt_install docker.io docker-compose-v2
fi
if command -v docker >/dev/null && [[ ! -f /etc/docker/daemon.json ]]; then
  # Published ports stay on localhost: apps are reached through tailscale serve / your proxy, never the LAN.
  install -d -m 0755 /etc/docker
  cat >/etc/docker/daemon.json <<'JSON'
{
  "ip": "127.0.0.1",
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  say "wrote /etc/docker/daemon.json (ports bind to 127.0.0.1)"
  [[ -n ${MANAR_NO_SERVICE:-} ]] || systemctl enable --now docker >/dev/null 2>&1 || true
elif command -v docker >/dev/null && ! grep -q '"ip"' /etc/docker/daemon.json; then
  echo "note: /etc/docker/daemon.json exists without \"ip\": \"127.0.0.1\"; app ports may be reachable on your LAN."
fi

if [[ -z ${MANAR_NO_TAILSCALE:-} ]] && ! command -v tailscale >/dev/null; then
  say "installing Tailscale"
  curl -fsSL https://tailscale.com/install.sh | sh
fi

# ---- 3. code ----------------------------------------------------------------
if [[ -d $DIR/.git ]]; then
  say "updating $DIR"
  git -C "$DIR" fetch -q origin "$REF"
  git -C "$DIR" checkout -q "$REF" 2>/dev/null || true
  git -C "$DIR" reset -q --hard "origin/$REF" 2>/dev/null || git -C "$DIR" reset -q --hard FETCH_HEAD
elif [[ -d $REPO ]]; then
  say "copying $REPO -> $DIR"
  mkdir -p "$DIR"
  rsync -a --exclude node_modules --exclude dist --exclude var --exclude .git "$REPO/" "$DIR/"
else
  say "cloning $REPO ($REF) -> $DIR"
  git clone -q --depth 1 --branch "$REF" "$REPO" "$DIR"
fi
chown -R "$USER_NAME:$GROUP_NAME" "$DIR"

say "building (this takes a minute)"
runuser -u "$USER_NAME" -- env HOME="$(getent passwd "$USER_NAME" | cut -d: -f6)" npm --prefix "$DIR" ci --no-audit --no-fund --loglevel=error
runuser -u "$USER_NAME" -- npm --prefix "$DIR" run build --silent

if [[ -n ${MANAR_NO_SERVICE:-} ]]; then
  say "built in $DIR (MANAR_NO_SERVICE set: no service installed)"
  exit 0
fi

# ---- 4. system pieces -------------------------------------------------------
if [[ -z ${MANAR_NO_TAILSCALE:-} ]] && command -v tailscale >/dev/null && ! tailscale status >/dev/null 2>&1; then
  say "Tailscale is installed but not signed in. Run: sudo tailscale up   (then re-run this installer to publish the HTTPS port)"
fi
args=(--user "$USER_NAME" --data-root "$DATA_ROOT")
[[ -z ${MANAR_NO_TAILSCALE:-} ]] || args+=(--no-tailscale)
bash "$DIR/deploy/install.sh" "${args[@]}"
