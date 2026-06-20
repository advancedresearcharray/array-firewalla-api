from __future__ import annotations

import hashlib
import hmac
import ipaddress
import os
from typing import Iterable

def load_allow_cidrs() -> tuple[str, ...]:
    raw = os.environ.get("FIREWALLA_API_ALLOW_CIDRS", "")
    return tuple(p.strip() for p in raw.split(",") if p.strip())


def ip_allowed(ip: str, cidrs: Iterable[str] | None = None) -> bool:
    if not ip:
        return False
    if ip.startswith("::ffff:"):
        ip = ip[7:]
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    for cidr in cidrs or load_allow_cidrs():
        if addr in ipaddress.ip_network(cidr, strict=False):
            return True
    return False


def token_configured() -> bool:
    return bool(os.environ.get("FIREWALLA_API_TOKEN"))


def check_bearer(header: str | None) -> bool:
    expected = os.environ.get("FIREWALLA_API_TOKEN", "")
    if not expected:
        return True
    if not header:
        return False
    prefix = "Bearer "
    if not header.startswith(prefix):
        return False
    got = header[len(prefix) :].strip()
    return hmac.compare_digest(
        hashlib.sha256(got.encode()).digest(),
        hashlib.sha256(expected.encode()).digest(),
    )
