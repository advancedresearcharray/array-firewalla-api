#!/usr/bin/env bash
# ONE-TIME bootstrap: push array-firewalla-api onto Firewalla via SSH.
# After this, use deploy-firewalla-api.sh and push-firewalla-tools-api.sh (HTTP only).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
: "${FIREWALLA_HOST:?Set FIREWALLA_HOST (Firewalla LAN IP, e.g. A.A.A.A)}"
FIREWALLA_USER="${FIREWALLA_USER:-pi}"

FW_PASS=""
if [[ -f /root/scripts/array-bitwarden-password.sh ]]; then
  # shellcheck disable=SC1091
  source /root/scripts/array-bitwarden-password.sh
  FW_PASS="$(array_bw_unlock_get_password firewalla 2>/dev/null || true)"
fi

scp_to_fw() {
  local src="$1" dst="$2"
  if [[ -n "$FW_PASS" ]] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$FW_PASS" scp -o StrictHostKeyChecking=accept-new "$src" "${FIREWALLA_USER}@${FIREWALLA_HOST}:${dst}"
  else
    scp -o StrictHostKeyChecking=accept-new "$src" "${FIREWALLA_USER}@${FIREWALLA_HOST}:${dst}"
  fi
}

ssh_fw() {
  local cmd="$1"
  if [[ -n "$FW_PASS" ]] && command -v sshpass >/dev/null 2>&1; then
    sshpass -p "$FW_PASS" ssh -o StrictHostKeyChecking=accept-new "${FIREWALLA_USER}@${FIREWALLA_HOST}" "$cmd"
  else
    ssh -o StrictHostKeyChecking=accept-new "${FIREWALLA_USER}@${FIREWALLA_HOST}" "$cmd"
  fi
}

echo "[bootstrap] ONE-TIME SSH push to ${FIREWALLA_HOST} — fleet ops after this are HTTP-only"
ssh_fw "mkdir -p /tmp/array-firewalla-api/lib /tmp/array-firewalla-api/bridge /tmp/array-firewalla-api/data /tmp/array-firewalla-api/deploy /tmp/array-firewalla-api/scripts"
for f in server.py lib/auth.py lib/runner.py lib/netbot.py lib/__init__.py bridge/netbot-bridge.js data/netbot-catalog.txt deploy/firewalla-api.service deploy/netbot-bridge.service deploy/config.env.example scripts/install-on-firewalla.sh; do
  scp_to_fw "$ROOT_DIR/$f" "/tmp/array-firewalla-api/$f"
done
ssh_fw "bash /tmp/array-firewalla-api/scripts/install-on-firewalla.sh"
TOKEN="$(ssh_fw "sudo grep -E '^FIREWALLA_API_TOKEN=' /etc/default/firewalla-api | cut -d= -f2-" | tr -d '\r\n')"
mkdir -p /root/.secrets
printf 'FIREWALLA_API_URL=http://%s:9378\nFIREWALLA_API_TOKEN=%s\n' "$FIREWALLA_HOST" "$TOKEN" > /root/.secrets/firewalla-api.env
chmod 600 /root/.secrets/firewalla-api.env
echo "[bootstrap] Token saved to /root/.secrets/firewalla-api.env"
curl -sS -m 10 "http://${FIREWALLA_HOST}:9378/api/health" | head -c 300
echo
