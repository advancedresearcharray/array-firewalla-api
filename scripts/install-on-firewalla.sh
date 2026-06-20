#!/usr/bin/env bash
# Install array-firewalla-api on Firewalla (run ON Firewalla as pi, or via deploy script).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -d /tmp/array-firewalla-api ]] && [[ -f /tmp/array-firewalla-api/server.py ]]; then
  REPO_ROOT="/tmp/array-firewalla-api"
fi
INSTALL_DIR="/home/pi/array-firewalla-api"
ENV_FILE="/etc/default/firewalla-api"

echo "[firewalla-api] Installing to ${INSTALL_DIR}"
mkdir -p "$INSTALL_DIR/lib" "$INSTALL_DIR/bridge" "$INSTALL_DIR/data"
install -m 644 "$REPO_ROOT/server.py" "$INSTALL_DIR/server.py"
install -m 644 "$REPO_ROOT/lib/auth.py" "$INSTALL_DIR/lib/auth.py"
install -m 644 "$REPO_ROOT/lib/runner.py" "$INSTALL_DIR/lib/runner.py"
install -m 644 "$REPO_ROOT/lib/netbot.py" "$INSTALL_DIR/lib/netbot.py"
install -m 644 "$REPO_ROOT/lib/__init__.py" "$INSTALL_DIR/lib/__init__.py"
install -m 644 "$REPO_ROOT/bridge/netbot-bridge.js" "$INSTALL_DIR/bridge/netbot-bridge.js"
install -m 644 "$REPO_ROOT/data/netbot-catalog.txt" "$INSTALL_DIR/data/netbot-catalog.txt"
install -m 644 "$REPO_ROOT/deploy/firewalla-api.service" /tmp/firewalla-api.service
install -m 644 "$REPO_ROOT/deploy/netbot-bridge.service" /tmp/netbot-bridge.service

if [[ ! -f "$ENV_FILE" ]]; then
  sudo install -m 600 "$REPO_ROOT/deploy/config.env.example" "$ENV_FILE"
  TOKEN="$(openssl rand -hex 32)"
  echo "FIREWALLA_API_TOKEN=${TOKEN}" | sudo tee -a "$ENV_FILE" >/dev/null
  sudo chmod 600 "$ENV_FILE"
  echo "[firewalla-api] Generated token in ${ENV_FILE}"
else
  echo "[firewalla-api] Keeping existing ${ENV_FILE}"
fi

if command -v systemctl >/dev/null 2>&1; then
  sudo install -m 644 /tmp/netbot-bridge.service /etc/systemd/system/netbot-bridge.service
  sudo install -m 644 /tmp/firewalla-api.service /etc/systemd/system/firewalla-api.service
  sudo systemctl daemon-reload
  sudo systemctl enable netbot-bridge.service firewalla-api.service
  sudo systemctl restart netbot-bridge.service
  sleep 2
  sudo systemctl restart firewalla-api.service
  sleep 2
  sudo systemctl is-active netbot-bridge.service
  sudo systemctl is-active firewalla-api.service
else
  echo "[firewalla-api] systemd not found — start manually"
fi

echo ""
echo "[firewalla-api] Health: curl http://\${BIND_ADDRESS:-A.A.A.A}:9378/api/health"
