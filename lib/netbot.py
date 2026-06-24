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


def netbot_invoke(
    mtype: str,
    data: dict[str, Any] | None = None,
    *,
    target: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"mtype": mtype, "data": dict(data or {})}
    resolved_target = target or body["data"].pop("target", None)
    if resolved_target:
        body["target"] = resolved_target
    payload = _http_json(
        "POST",
        f"{BRIDGE_URL}/invoke",
        body,
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


def list_policies() -> list[dict[str, Any]]:
    result = netbot_get("policies")
    data = result.get("data") or result
    policies = data.get("policies") if isinstance(data, dict) else []
    return policies if isinstance(policies, list) else []


def qos_policies_for_mac(mac: str) -> list[dict[str, Any]]:
    norm = mac.upper().replace("-", ":")
    out: list[dict[str, Any]] = []
    for policy in list_policies():
        if str(policy.get("action", "")).lower() != "qos":
            continue
        if str(policy.get("disabled", "0")) not in ("0", ""):
            continue
        scope = policy.get("scope") or []
        if norm in {str(s).upper().replace("-", ":") for s in scope}:
            out.append(policy)
    return out


def ensure_mac_qos_rule(
    mac: str,
    *,
    traffic_direction: str,
    notes: str,
    rate_limit: int | None = None,
    priority: int | None = None,
) -> Any:
    scoped = qos_policies_for_mac(mac)
    existing = next((p for p in scoped if p.get("notes") == notes), None)
    value: dict[str, Any] = {
        "type": "mac",
        "action": "qos",
        "direction": "bidirection",
        "trafficDirection": traffic_direction,
        "scope": [mac.upper().replace("-", ":")],
        "qdisc": "fq_codel",
        "disabled": "0",
        "notes": notes,
    }
    if rate_limit is not None:
        value["rateLimit"] = rate_limit
    if priority is not None:
        value["priority"] = priority
    if existing and existing.get("pid"):
        return netbot_cmd("policy:update", {"pid": existing["pid"], **value})
    return netbot_cmd("policy:create", value)
