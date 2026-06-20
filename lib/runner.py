from __future__ import annotations

import base64
import json
import os
import subprocess
import tempfile
from pathlib import Path

TOOLS_DIR = Path(os.environ.get("FIREWALLA_TOOLS_DIR", "/home/pi/gaming-tools"))
INSTALL_DIR = Path(os.environ.get("FIREWALLA_API_INSTALL_DIR", "/home/pi/array-firewalla-api"))

ALLOWED_SCRIPTS = frozenset(
    {
        "gaming-snapshot.sh",
        "gaming-role-qos.sh",
        "gaming-bandwidth-qos.sh",
        "gaming-buffer-tune.sh",
        "gaming-dns-policy.sh",
        "gaming-route-probe.sh",
        "gaming-route-enforce.sh",
        "gaming-nat-check.sh",
        "gaming-mtu-probe.sh",
        "gaming-offload-audit.sh",
        "gaming-firewalla-tune.sh",
        "gaming-processor-tune.sh",
        "gaming-link-status.sh",
        "xbox-scope.sh",
    }
)

ALLOWED_DATA_FILES = frozenset({"route-probes.json", "gaming.conf"})

ALLOWED_API_FILES = frozenset(
    {
        "server.py",
        "lib/auth.py",
        "lib/runner.py",
        "lib/netbot.py",
        "lib/__init__.py",
        "bridge/netbot-bridge.js",
        "data/netbot-catalog.txt",
        "static/index.html",
        "static/app.js",
        "static/style.css",
    }
)


def _script_path(name: str) -> Path:
    base = Path(name).name
    if base not in ALLOWED_SCRIPTS:
        raise ValueError(f"script not allowed: {base}")
    full = TOOLS_DIR / base
    if not str(full.resolve()).startswith(str(TOOLS_DIR.resolve())):
        raise ValueError("invalid script path")
    return full


def run_script(
    script: str,
    args: list[str] | None = None,
    *,
    sudo: bool = False,
    payload: object | None = None,
) -> dict[str, object]:
    script_path = _script_path(script)
    final_args = list(args or [])
    tmp_dir: tempfile.TemporaryDirectory[str] | None = None

    if payload is not None:
        tmp_dir = tempfile.TemporaryDirectory(prefix="fw-api-")
        payload_path = Path(tmp_dir.name) / "payload.json"
        payload_path.write_text(json.dumps(payload), encoding="utf-8")
        final_args = ["@payload" if arg == "@payload" else arg for arg in final_args]
        final_args = [str(payload_path) if arg == "@payload" else arg for arg in final_args]

    cmd: list[str] = []
    if sudo:
        cmd.append("sudo")
    cmd.extend(["bash", str(script_path), *final_args])

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or f"command failed ({proc.returncode})")
    return {"ok": True, "stdout": proc.stdout.strip()}


def run_system_probe() -> dict[str, object]:
    proc = subprocess.run(
        [
            "bash",
            "-lc",
            r"""
for i in 0 1 2 3; do
  echo "=== eth${i} ==="
  ethtool "eth${i}" 2>/dev/null | egrep 'Speed|Duplex|Link detected|Auto-negotiation' || echo "unavailable"
done
cat /proc/loadavg
grep -m1 MemAvailable /proc/meminfo
""",
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "system probe failed")
    return {"ok": True, "stdout": proc.stdout.strip()}


def list_scripts() -> list[str]:
    return sorted(ALLOWED_SCRIPTS)


def _write_executable(path: Path, content: bytes, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    path.chmod(mode)


def install_tool(name: str, content_b64: str, *, mode: int = 0o755) -> dict[str, object]:
    base = Path(name).name
    raw = base64.b64decode(content_b64, validate=True)
    if base in ALLOWED_SCRIPTS:
        dest = _script_path(base)
        _write_executable(dest, raw, mode)
        return {"ok": True, "installed": str(dest), "bytes": len(raw)}
    if base in ALLOWED_DATA_FILES:
        dest = TOOLS_DIR / base
        if not str(dest.resolve()).startswith(str(TOOLS_DIR.resolve())):
            raise ValueError("invalid data path")
        _write_executable(dest, raw, mode)
        return {"ok": True, "installed": str(dest), "bytes": len(raw)}
    raise ValueError(f"file not allowed: {base}")


def sync_api_files(files: list[dict[str, str]]) -> dict[str, object]:
    installed: list[str] = []
    for entry in files:
        rel = entry.get("path", "")
        content_b64 = entry.get("content", "")
        if rel not in ALLOWED_API_FILES:
            raise ValueError(f"path not allowed: {rel}")
        raw = base64.b64decode(content_b64, validate=True)
        dest = INSTALL_DIR / rel
        if not str(dest.resolve()).startswith(str(INSTALL_DIR.resolve())):
            raise ValueError(f"invalid path: {rel}")
        mode = 0o755 if rel.endswith(".js") else 0o644
        _write_executable(dest, raw, mode)
        installed.append(rel)
    return {"ok": True, "installed": installed, "count": len(installed)}


def restart_api_services(*, detach: bool = False) -> dict[str, object]:
    cmd = [
        "sudo",
        "systemctl",
        "restart",
        "netbot-bridge.service",
        "firewalla-api.service",
    ]
    if detach:
        subprocess.Popen(
            cmd,
            start_new_session=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return {"ok": True, "restarted": "scheduled"}
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr.strip() or "service restart failed")
    return {"ok": True, "restarted": ["netbot-bridge", "firewalla-api"]}
