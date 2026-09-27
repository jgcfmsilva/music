#!/usr/bin/env bash
# Deploy music (custom Navidrome web UI + delete API) on host port 4041.
# Brings the stack up, installs + enables the systemd unit, refreshes the
# proxy-only firewall.
#
#   run:  sudo bash ./deploy.sh
#
# AUX (default: ../aux next to this folder) holds the shared host scripts:
# startup/wait-for-pool.sh and, optionally, setup/restrict-to-proxy.sh.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUX="${AUX:-$(cd "$HERE/.." && pwd)/aux}"
UNIT=music-compose.service
cd "$HERE"

[[ $EUID -eq 0 ]] || { echo "run with sudo: sudo bash $0" >&2; exit 1; }

echo "== 1. bring up the stack =="
docker compose up -d --build --remove-orphans

echo "== 2. install + enable the systemd unit =="
sed -e "s|@HERE@|$HERE|g" -e "s|@AUX@|$AUX|g" "$HERE/$UNIT" > "/etc/systemd/system/$UNIT"
chmod 0644 "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable "$UNIT"

echo "== 3. restrict port 4041 to the reverse proxy (if the host script exists) =="
if [[ -x "$AUX/scripts/setup/restrict-to-proxy.sh" || -f "$AUX/scripts/setup/restrict-to-proxy.sh" ]]; then
  bash "$AUX/scripts/setup/restrict-to-proxy.sh"
else
  echo "   skipped: $AUX/scripts/setup/restrict-to-proxy.sh not found"
fi

cat <<MSG

music is on http://<this host>:4041  (put it behind your reverse proxy).

It serves the UI and proxies /rest/* (Navidrome) and /api/* (delete API)
itself, so the reverse proxy only needs to forward everything for its vhost
to <this host>:4041.
Preview without Caddy:
  ssh -L 4041:127.0.0.1:4041 <user>@<this host>   then  http://localhost:4041
MSG
