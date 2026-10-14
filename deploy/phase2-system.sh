#!/bin/bash
# Phase 2 system changes. Run ONLY after you approve: sudo deploy/phase2-system.sh
#   1. /etc/docker/daemon.json: published ports default to 127.0.0.1 (backup first)
#   2. enable + start containerd and docker
#   3. remove the old Dockge and Ollama-in-Docker containers right away
#      (they are restart=unless-stopped and the Ollama one would fight the real
#      Ollama for port 11434)
#   4. archive /srv/apps/dockge and /srv/apps/ollama to /var/backups/manar/<ts>/, then delete them
# NOT touched: /srv/data/ollama (data folder the old compose mounted), the real
# ollama.service, and every other service.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "run with sudo" >&2; exit 1; }

TS=$(date +%Y%m%d-%H%M%S)
BACKUP=/var/backups/manar/$TS
mkdir -p "$BACKUP"

# 1. Docker daemon config — merge, never clobber silently.
mkdir -p /etc/docker
if [[ -f /etc/docker/daemon.json ]]; then
  cp -a /etc/docker/daemon.json "$BACKUP/daemon.json"
  echo "existing /etc/docker/daemon.json backed up; add \"ip\": \"127.0.0.1\" to it by hand:"
  cat /etc/docker/daemon.json
else
  cat >/etc/docker/daemon.json <<'JSON'
{
  "ip": "127.0.0.1",
  "log-driver": "local",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  echo "wrote /etc/docker/daemon.json (ports bind to 127.0.0.1 unless a compose file says otherwise)"
fi

# 2. Start Docker.
systemctl enable --now containerd.service docker.service
for i in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
docker info >/dev/null

# 3. Old containers out (ignore if absent).
for c in dockge ollama; do
  if docker inspect "$c" >/dev/null 2>&1; then
    docker rm -f "$c"
    echo "removed container $c"
  fi
done

# 4. Archive, then delete the old stacks.
for d in /srv/apps/dockge /srv/apps/ollama; do
  if [[ -d $d ]]; then
    tar -C /srv/apps -czf "$BACKUP/$(basename "$d").tar.gz" "$(basename "$d")"
    rm -rf --one-file-system -- "$d"
    echo "archived and removed $d"
  fi
done

# Manar runs as anas (already in the docker group) — nothing else to grant.
mkdir -p /srv/data/apps && chown anas:anas /srv/data/apps

echo
echo "Done. Backups: $BACKUP"
docker ps -a --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
ss -ltnp 'sport = :11434' | tail -n +2
