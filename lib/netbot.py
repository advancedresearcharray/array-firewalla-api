from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

BRIDGE_URL = os.environ.get(
    "FIREWALLA_NETBOT_BRIDGE_URL", "http://127.0.0.1:8836"
).rstrip("/")
LOCAL_API_URL = os.environ.get(
    "FIREWALLA_LOCAL_API_URL", "http://127.0.0.1:8834"
).rstrip("/")
CATALOG_PATH = Path(__file__).resolve().parent.parent / "data" / "netbot-catalog.txt"

# Common mobile-app screens → netbot items (generic /invoke covers everything else)
MOBILE_SHORTCUTS: dict[str, dict[str, Any]] = {
    "hosts": {"mtype": "get", "data": {"item": "hosts"}},
    "alarms": {"mtype": "get", "data": {"item": "alarms"}},
    "policies": {"mtype": "get", "data": {"item": "policies"}},
    "exceptions": {"mtype": "get", "data": {"item": "exceptions"}},
    "sysInfo": {"mtype": "get", "data": {"item": "sysInfo"}},
    "mode": {"mtype": "get", "data": {"item": "mode"}},
    "flows": {"mtype": "get", "data": {"item": "flows"}},
    "vpnProfiles": {"mtype": "get", "data": {"item": "vpnProfiles"}},
    "tags": {"mtype": "get", "data": {"item": "tag"}},
    "networkConfig": {"mtype": "get", "data": {"item": "networkConfig"}},
    "upgradeInfo": {"mtype": "get", "data": {"item": "upgradeInfo"}},
}


def load_catalog() -> list[str]:
    if not CATALOG_PATH.is_file():
        return sorted(MOBILE_SHORTCUTS.keys())
    items = [
        line.strip()
        for line in CATALOG_PATH.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    return sorted(set(items))


def _http_json(
    method: str,
    url: str,
    body: dict[str, Any] | None = None,
    timeout: float = 120.0,
) -> dict[str, Any]:
    data = None
    headers = {"Accept": "application/json"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(detail)
        except json.JSONDecodeError:
            parsed = {"error": detail or exc.reason}
        raise RuntimeError(parsed.get("error") or parsed.get("message") or str(exc)) from exc


def bridge_health() -> dict[str, Any]:
    return _http_json("GET", f"{BRIDGE_URL}/health", timeout=10.0)


def netbot_invoke(mtype: str, data: dict[str, Any] | None = None) -> dict[str, Any]:
    payload = _http_json(
        "POST",
        f"{BRIDGE_URL}/invoke",
        {"mtype": mtype, "data": data or {}},
    )
    result = payload.get("result") or {}
    code = result.get("code", 500)
    if code >= 400:
        raise RuntimeError(result.get("message") or f"netbot error {code}")
    return result


def netbot_get(item: str, value: dict[str, Any] | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {"item": item}
    if value:
        data["value"] = value
    return netbot_invoke("get", data)


def netbot_cmd(item: str, value: dict[str, Any] | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {"item": item}
    if value:
        data["value"] = value
    return netbot_invoke("cmd", data)


def mobile_shortcut(name: str) -> dict[str, Any]:
    spec = MOBILE_SHORTCUTS.get(name)
    if not spec:
        raise ValueError(f"unknown mobile shortcut: {name}")
    return netbot_invoke(spec["mtype"], spec["data"])


def local_get(path: str) -> Any:
    url = f"{LOCAL_API_URL}/v1/{path.lstrip('/')}"
    return _http_json("GET", url, timeout=60.0)


def local_post(path: str, body: dict[str, Any]) -> Any:
    url = f"{LOCAL_API_URL}/v1/{path.lstrip('/')}"
    return _http_json("POST", url, body, timeout=60.0)
