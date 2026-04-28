"""Prometheus-format metrics endpoint for the console process.

Exposes a small set of counters / gauges every operator wants when the
console misbehaves: process uptime, MessageBus queue depths, OpenAI
session-lock cache size, and active embedded-runtime indicators.  We
hand-format the text instead of pulling in the prometheus_client
library because the surface is intentionally tiny and the dependency
would only earn its keep at much larger scale.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Request
from fastapi.responses import PlainTextResponse

router = APIRouter(tags=["Metrics"])


def _line(name: str, value: float, *, help_text: str = "", type_: str = "gauge") -> list[str]:
    """Render one metric block (HELP + TYPE + sample) for the text exposition format."""
    out: list[str] = []
    if help_text:
        out.append(f"# HELP {name} {help_text}")
    out.append(f"# TYPE {name} {type_}")
    out.append(f"{name} {value}")
    return out


@router.get("/metrics", response_class=PlainTextResponse)
async def get_metrics(request: Request) -> PlainTextResponse:
    """Return process metrics in Prometheus text format.

    The endpoint is intentionally read-only and does not require auth in
    the current console layout (which has no auth at all - see roadmap
    P0).  When a future release introduces a token, exempt this route
    from it so scrape jobs keep working.
    """
    state = request.app.state
    now = time.perf_counter()
    started = float(getattr(state, "started_at_perf", now))
    uptime = max(0.0, now - started)

    lines: list[str] = []
    lines.extend(
        _line(
            "openpawlet_uptime_seconds",
            round(uptime, 3),
            help_text="Seconds since console process start.",
        )
    )

    embedded = getattr(state, "embedded", None)
    runtime_ready = 1.0 if embedded is not None else 0.0
    lines.extend(
        _line(
            "openpawlet_runtime_ready",
            runtime_ready,
            help_text="1 when the embedded OpenPawlet runtime is up, 0 otherwise.",
        )
    )

    bus = getattr(state, "message_bus", None)
    inbound = float(getattr(bus, "inbound_size", 0)) if bus is not None else 0.0
    outbound = float(getattr(bus, "outbound_size", 0)) if bus is not None else 0.0
    lines.extend(
        _line(
            "openpawlet_bus_inbound_pending",
            inbound,
            help_text="Pending inbound messages on the in-process bus.",
        )
    )
    lines.extend(
        _line(
            "openpawlet_bus_outbound_pending",
            outbound,
            help_text="Pending outbound messages on the in-process bus.",
        )
    )

    locks = getattr(state, "openai_session_locks", None)
    lock_count = float(len(locks)) if locks is not None and hasattr(locks, "__len__") else 0.0
    lines.extend(
        _line(
            "openpawlet_openai_session_locks",
            lock_count,
            help_text="Live entries in the per-session OpenAI lock cache.",
        )
    )

    return PlainTextResponse("\n".join(lines) + "\n", media_type="text/plain; version=0.0.4")
