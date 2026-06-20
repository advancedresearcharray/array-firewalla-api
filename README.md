# Array Firewalla LAN API

HTTP management API on **Firewalla Gold/Purple**, bound to your **Firewalla LAN IP** and restricted to your **LAN CIDR**. Provides **full mobile-app parity** via the same netbot controller the Firewalla app uses — no SSH required.

> **Disclaimer:** This is an independent community project. It is **not affiliated with, endorsed by, or supported by Firewalla Inc.** It exposes internal Firewalla APIs and can run privileged commands on your device. **Use at your own risk.** You are solely responsible for any impact to your network, device stability, security, or warranty. Firewalla may change internal behavior at any time, which could break this software without notice.

### Address placeholders

| Placeholder | Role |
|-------------|------|
| `A.A.A.A` | Firewalla LAN IP |
| `X.X.X.0/24` | Your LAN CIDR allowlist |

## Architecture

```
LAN client (your LAN CIDR)
    → array-firewalla-api :9378  (Python, LAN-facing, bearer auth)
        → netbot-bridge :8836    (Node, localhost — mobile app controller path)
        → FireAPI local :8834     (localhost — host/all in production)
        → /home/pi/gaming-tools  (Xbox monitor scripts)
```

The mobile app talks to netbot through encrypted `/v1/encipher`. This API exposes the **same netbot items** over plain HTTP on the LAN with your configured bearer secret.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/health` | Service + netbot bridge status |
| GET | `/api/v1/catalog` | 245+ netbot items + mobile shortcuts |
| GET | `/api/v1/mobile` | Shortcut map |
| GET | `/api/v1/mobile/{name}` | Common screens: `hosts`, `alarms`, `policies`, … |
| GET | `/api/v1/netbot/{item}` | `get` netbot item (`?value=` JSON optional) |
| POST | `/api/v1/netbot` | **Full mobile parity** — `{mtype, data}` |
| GET | `/api/v1/local/host/all` | Production local host list (8834) |
| GET | `/api/v1/local/host/{mac\|ip}` | Host detail + flows |
| POST | `/api/v1/run` | Allowlisted gaming-tools scripts |

All `/api/v1/*` routes except health require `Authorization: Bearer <secret>`.

### Generic netbot (anything the app can do)

```bash
# List all devices (same as app Devices screen)
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "http://A.A.A.A:9378/api/v1/netbot" \
  -d '{"mtype":"get","data":{"item":"hosts"}}'

# Alarms
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  "http://A.A.A.A:9378/api/v1/mobile/alarms"

# Create/update policy (cmd — same as app Rules)
curl -H "Authorization: Bearer $FIREWALLA_API_TOKEN" \
  -X POST "http://A.A.A.A:9378/api/v1/netbot" \
  -d '{"mtype":"cmd","data":{"item":"policy:create","value":{...}}}'
```

See `data/netbot-catalog.txt` for all supported `item` values (`alarm:block`, `vpnProfile:list`, `mode`, `sysInfo`, …).

## Deploy

```bash
FIREWALLA_API_URL=http://A.A.A.A:9378 ./scripts/deploy-firewalla-api.sh
```

Installs on Firewalla:
- `/home/pi/array-firewalla-api/`
- `netbot-bridge.service` (127.0.0.1:8836)
- `firewalla-api.service` (A.A.A.A:9378 — set `BIND_ADDRESS` in `/etc/default/firewalla-api`)
- Bearer secret in `/etc/default/firewalla-api`

## Security

- LAN bind + CIDR allowlist only
- Bearer secret for all management routes
- Netbot bridge is **localhost-only** (not reachable from LAN directly)
- Gaming script allowlist unchanged
