"""Gateway ``GET /health`` URL for console probes (no observability data over HTTP)."""

from __future__ import annotations


def normalize_gateway_host(host: str) -> str:
    """Map bind addresses (0.0.0.0, ::) to loopback; bracket IPv6 for URL."""
    h = (host or "").strip()
    if h in ("", "0.0.0.0", "::", "[::]"):
        return "127.0.0.1"
    if h.count(":") > 1 and not h.startswith("["):
        return f"[{h}]"
    return h


def gateway_health_url(host: str, port: int) -> str:
    h = normalize_gateway_host(host)
    return f"http://{h}:{port}/health"
