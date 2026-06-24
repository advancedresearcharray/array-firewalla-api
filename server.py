#!/usr/bin/env python3
from __future__ import annotations

import json
import mimetypes
import os
import socketserver
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from lib.auth import check_bearer, ip_allowed, load_allow_cidrs, token_configured
from lib.netbot import (
    MOBILE_SHORTCUTS,
    bridge_health,
    load_catalog,
    local_get,
    mobile_shortcut,
    netbot_get,
    netbot_invoke,
)
from lib.runner import (
    install_tool,
    list_scripts,
    restart_api_services,
    run_script,
    run_system_probe,
    sync_api_files,
)

PORT = int(os.environ.get("PORT", "9378"))
BIND_ADDRESS = os.environ.get("BIND_ADDRESS", "").strip()
ALLOW_CIDRS = load_allow_cidrs()
STATIC_DIR = Path(__file__).resolve().parent / "static"


def json_response(handler: BaseHTTPRequestHandler, status: int, body: Any) -> None:
    payload = json.dumps(body).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)


class FirewallaApiHandler(BaseHTTPRequestHandler):
    server_version = "array-firewalla-api/2.0"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[firewalla-api] {self.address_string()} {fmt % args}")

    def _client_ip(self) -> str:
        return self.client_address[0]

    def _reject_unless_allowed(self) -> bool:
        ip = self._client_ip()
        if not ip_allowed(ip, ALLOW_CIDRS):
            json_response(
                self,
                403,
                {"error": "forbidden", "detail": "LAN clients only", "clientIp": ip},
            )
            return False
        return True

    def _reject_unless_authed(self) -> bool:
        if not check_bearer(self.headers.get("Authorization")):
            json_response(self, 401, {"error": "unauthorized"})
            return False
        return True

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        return json.loads(raw.decode("utf-8"))

    def _parsed_path(self) -> tuple[str, dict[str, list[str]]]:
        parsed = urllib.parse.urlparse(self.path)
        return parsed.path, urllib.parse.parse_qs(parsed.query)

    def _handle_health(self) -> None:
        bridge: dict[str, Any] = {"ok": False}
        try:
            bridge = bridge_health()
        except Exception as exc:  # noqa: BLE001
            bridge = {"ok": False, "error": str(exc)}
        json_response(
            self,
            200,
            {
                "ok": True,
                "service": "array-firewalla-api",
                "version": 2,
                "bindAddress": BIND_ADDRESS,
                "port": PORT,
                "allowCidrs": list(ALLOW_CIDRS),
                "tokenRequired": token_configured(),
                "toolsDir": os.environ.get("FIREWALLA_TOOLS_DIR", "/home/pi/gaming-tools"),
                "netbotBridge": bridge,
                "mobileParity": "POST /api/v1/netbot with {mtype,data} — same netbot path as mobile app",
            },
        )

    def _handle_catalog(self) -> None:
        json_response(
            self,
            200,
            {
                "netbotItems": load_catalog(),
                "mobileShortcuts": sorted(MOBILE_SHORTCUTS.keys()),
                "usage": {
                    "generic": "POST /api/v1/netbot {mtype: get|cmd|set, data: {item, value?}}",
                    "shortcut": "GET /api/v1/mobile/{shortcut}",
                    "localHost": "GET /api/v1/local/host/all (production FireAPI local)",
                },
            },
        )

    def _handle_mobile_shortcut(self, name: str) -> None:
        result = mobile_shortcut(name)
        json_response(self, 200, {"ok": True, "shortcut": name, "result": result})

    def _handle_netbot_get_item(self, item: str, query: dict[str, list[str]]) -> None:
        value_raw = (query.get("value") or [None])[0]
        value = json.loads(value_raw) if value_raw else None
        result = netbot_get(item, value)
        json_response(self, 200, {"ok": True, "result": result})

    def _handle_netbot_post(self, body: dict[str, Any]) -> None:
        mtype = body.get("mtype")
        data = body.get("data") or {}
        target = body.get("target")
        if not mtype:
            json_response(self, 400, {"error": "mtype required (get, cmd, set, ...)"})
            return
        result = netbot_invoke(str(mtype), dict(data), target=target)
        json_response(self, 200, {"ok": True, "result": result})

    def _handle_local(self, subpath: str) -> None:
        result = local_get(subpath)
        json_response(self, 200, result)

    def _serve_static(self, path: str) -> bool:
        rel = path.lstrip("/")
        if rel in ("", "index.html"):
            rel = "index.html"
        elif rel.startswith("static/"):
            rel = rel[len("static/") :]
        if not rel or ".." in rel or rel.startswith("/"):
            return False
        file_path = (STATIC_DIR / rel).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())):
            return False
        if not file_path.is_file():
            return False
        content = file_path.read_bytes()
        mime, _ = mimetypes.guess_type(str(file_path))
        self.send_response(200)
        self.send_header("Content-Type", mime or "application/octet-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)
        return True

    def do_GET(self) -> None:
        if not self._reject_unless_allowed():
            return

        path, query = self._parsed_path()

        if path == "/api/health":
            self._handle_health()
            return

        if path == "/api/v1/catalog":
            if not self._reject_unless_authed():
                return
            self._handle_catalog()
            return

        if path == "/api/v1/mobile":
            if not self._reject_unless_authed():
                return
            json_response(self, 200, {"shortcuts": MOBILE_SHORTCUTS})
            return

        if path.startswith("/api/v1/mobile/"):
            if not self._reject_unless_authed():
                return
            name = path[len("/api/v1/mobile/") :]
            try:
                self._handle_mobile_shortcut(name)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path.startswith("/api/v1/netbot/"):
            if not self._reject_unless_authed():
                return
            item = path[len("/api/v1/netbot/") :]
            try:
                self._handle_netbot_get_item(item, query)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path.startswith("/api/v1/local/"):
            if not self._reject_unless_authed():
                return
            subpath = path[len("/api/v1/local/") :]
            try:
                self._handle_local(subpath)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 502, {"error": str(exc)})
            return

        if path == "/api/v1/scripts":
            if not self._reject_unless_authed():
                return
            json_response(self, 200, {"scripts": list_scripts()})
            return

        if path == "/api/v1/system":
            if not self._reject_unless_authed():
                return
            try:
                json_response(self, 200, run_system_probe())
            except Exception as exc:  # noqa: BLE001
                json_response(self, 500, {"error": str(exc)})
            return

        if path == "/" or path.startswith("/static/"):
            if self._serve_static(path):
                return

        json_response(self, 404, {"error": "not found"})

    def do_POST(self) -> None:
        if not self._reject_unless_allowed():
            return

        path, _query = self._parsed_path()

        if path == "/api/v1/netbot":
            if not self._reject_unless_authed():
                return
            try:
                self._handle_netbot_post(self._read_json())
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path == "/api/v1/run":
            if not self._reject_unless_authed():
                return
            try:
                body = self._read_json()
                result = run_script(
                    body.get("script", ""),
                    list(body.get("args") or []),
                    sudo=bool(body.get("sudo")),
                    payload=body.get("payload"),
                )
                json_response(self, 200, result)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path == "/api/v1/tools/update":
            if not self._reject_unless_authed():
                return
            try:
                body = self._read_json()
                mode = int(body.get("mode", "755"), 8)
                result = install_tool(
                    body.get("name", ""),
                    body.get("content", ""),
                    mode=mode,
                )
                json_response(self, 200, result)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path == "/api/v1/admin/sync":
            if not self._reject_unless_authed():
                return
            try:
                body = self._read_json()
                result = sync_api_files(list(body.get("files") or []))
                json_response(self, 200, result)
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        if path == "/api/v1/admin/restart":
            if not self._reject_unless_authed():
                return
            try:
                json_response(self, 200, restart_api_services(detach=True))
            except Exception as exc:  # noqa: BLE001
                json_response(self, 400, {"error": str(exc)})
            return

        json_response(self, 404, {"error": "not found"})


def main() -> None:
    if not BIND_ADDRESS:
        raise SystemExit("BIND_ADDRESS is required (set in /etc/default/firewalla-api)")
    if not ALLOW_CIDRS:
        raise SystemExit("FIREWALLA_API_ALLOW_CIDRS is required (set in /etc/default/firewalla-api)")
    with ThreadingHTTPServer((BIND_ADDRESS, PORT), FirewallaApiHandler) as httpd:
        print(f"array-firewalla-api listening on http://{BIND_ADDRESS}:{PORT}")
        print(f"  allow CIDRs: {', '.join(ALLOW_CIDRS)}")
        print(f"  token required: {token_configured()}")
        httpd.serve_forever()


if __name__ == "__main__":
    main()
