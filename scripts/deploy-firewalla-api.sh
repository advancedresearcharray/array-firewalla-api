#!/usr/bin/env bash
# Deploy / update array-firewalla-api on Firewalla via LAN HTTP only (no SSH).
#
# Requires one-time on-device bootstrap (App → SSH once, or physical access):
#   bash /path/to/array-firewalla-api/scripts/install-on-firewalla.sh
#
# After that, all updates use this script + FIREWALLA_API_TOKEN.
#
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TOKEN_FILE="${FIREWALLA_API_TOKEN_FILE:-/root/.secrets/firewalla-api.env}"

: "${FIREWALLA_API_URL:?Set FIREWALLA_API_URL (e.g. http://A.A.A.A:9378)}"

if [[ -f "$TOKEN_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$TOKEN_FILE"
fi

echo "[firewalla-api] Health check ${FIREWALLA_API_URL}"
if ! curl -sS -m 10 "${FIREWALLA_API_URL%/}/api/health" | grep -q '"ok"'; then
  echo "Firewalla API not reachable. Bootstrap once on device:" >&2
  echo "  bash ${ROOT_DIR}/scripts/install-on-firewalla.sh" >&2
  exit 1
fi

if [[ -z "${FIREWALLA_API_TOKEN:-}" ]]; then
  echo "Set FIREWALLA_API_TOKEN or create ${TOKEN_FILE}" >&2
  exit 1
fi

chmod +x "${ROOT_DIR}/../scripts/sync-firewalla-api-remote.sh" 2>/dev/null || true
"${ROOT_DIR}/../scripts/sync-firewalla-api-remote.sh" || {
  # when called from array-firewalla-api dir
  ROOT_REPO="$(cd "$ROOT_DIR/.." && pwd)"
  "$ROOT_REPO/scripts/sync-firewalla-api-remote.sh"
}

echo "[firewalla-api] Remote sync complete (no SSH used)"
