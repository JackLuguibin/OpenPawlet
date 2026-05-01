"""Helpers shared by the ``/cron`` API for service access and message metadata.

The console embeds OpenPawlet in-process via ``app.state.embedded.cron`` (see
``console/server/lifespan.py``). Whenever it is available we operate against
that live ``CronService`` instance so we don't fight it for the on-disk
``jobs.json`` mutex. When the embedded runtime is degraded (degraded mode),
we fall back to a transient ``CronService`` bound to the same store path so
the API still works for read/write.

Message metadata block: the web client encodes target info (agent id, skill
list, tool list, mcp servers, active window) as a JSON marker prepended to
``payload.message`` (see ``utils/cronMetadata.ts``). This module decodes that
block server-side so the history endpoint can return rich, ready-to-render
records without forcing the client to re-parse.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from fastapi import Request
from loguru import logger

from console.server.http_errors import service_unavailable
from openpawlet.cron.service import CronService

_META_RE = re.compile(r"^<!--cron-meta:(\{.*?\})-->\r?\n?", re.DOTALL)


@dataclass(frozen=True)
class CronMessageMeta:
    """Decoded metadata block extracted from a job's ``payload.message``."""

    agent_id: str | None = None
    skills: tuple[str, ...] = ()
    mcp_servers: tuple[str, ...] = ()
    tools: tuple[str, ...] = ()
    start_at_ms: int | None = None
    end_at_ms: int | None = None
    prompt: str = ""


def decode_cron_message(raw: str | None) -> CronMessageMeta:
    """Parse the optional ``<!--cron-meta:{...}-->`` prefix from a message."""
    if not raw:
        return CronMessageMeta()
    match = _META_RE.match(raw)
    if not match:
        return CronMessageMeta(prompt=raw)
    body = raw[match.end() :]
    try:
        meta_obj = json.loads(match.group(1))
    except (TypeError, ValueError):
        return CronMessageMeta(prompt=raw)
    if not isinstance(meta_obj, dict):
        return CronMessageMeta(prompt=raw)

    def _list(name: str) -> tuple[str, ...]:
        v = meta_obj.get(name)
        if not isinstance(v, list):
            return ()
        return tuple(str(item) for item in v if isinstance(item, str) and item)

    def _opt_int(name: str) -> int | None:
        v = meta_obj.get(name)
        if isinstance(v, bool):  # bool is subclass of int; reject
            return None
        if isinstance(v, (int, float)):
            return int(v)
        return None

    agent_raw = meta_obj.get("agentId")
    agent_id = str(agent_raw) if isinstance(agent_raw, str) and agent_raw else None
    return CronMessageMeta(
        agent_id=agent_id,
        skills=_list("skills"),
        mcp_servers=_list("mcpServers"),
        tools=_list("tools"),
        start_at_ms=_opt_int("startAtMs"),
        end_at_ms=_opt_int("endAtMs"),
        prompt=body,
    )


def get_cron_service(request: Request, bot_id: str | None) -> CronService | None:
    """Return the live cron service when embedded, else a fallback bound to disk.

    ``None`` is returned only when the workspace cannot be resolved at all
    (e.g. config files missing in degraded mode); callers should treat it as
    "no jobs available".
    """
    embedded = getattr(request.app.state, "embedded", None)
    if embedded is not None:
        cron = getattr(embedded, "cron", None)
        if isinstance(cron, CronService):
            return cron

    store_path = _resolve_store_path(bot_id)
    if store_path is None:
        return None
    return CronService(store_path)


def require_cron_service(request: Request, bot_id: str | None) -> CronService:
    """Return the cron service or raise HTTP 503 when no backend is available."""
    svc = get_cron_service(request, bot_id)
    if svc is None:
        service_unavailable("Cron service unavailable")
    return svc


def _resolve_store_path(bot_id: str | None) -> Path | None:
    """Resolve ``<workspace>/cron/jobs.json`` for the given bot.

    For an explicit ``bot_id`` we honor :func:`workspace_root` (which routes
    through the multi-bot registry). For the default bot (``bot_id is
    None``) we prefer OpenPawlet's globally-set config path so embedded /
    test setups that bypass the console bot registry still resolve a
    workspace deterministically.
    """
    if bot_id is None:
        try:
            import openpawlet.config.loader as _loader

            # Only honor the global override when a caller explicitly set
            # one (e.g. embedded runtime or test fixtures); otherwise fall
            # through to the console's per-bot registry below.
            if getattr(_loader, "_current_config_path", None) is not None:
                cfg = _loader.load_config()
                return cfg.workspace_path.resolve() / "cron" / "jobs.json"
        except Exception:
            logger.opt(exception=True).debug(
                "cron store path: global config override unavailable; using workspace_root"
            )
    try:
        from console.server.bot_workspace import workspace_root

        root = workspace_root(bot_id)
        return root / "cron" / "jobs.json"
    except Exception:
        return None


def cron_job_to_dict(job: Any) -> dict[str, Any]:
    """Serialize an OpenPawlet ``CronJob`` to the public API shape (snake_case)."""
    sched = job.schedule
    state = job.state
    payload = job.payload
    return {
        "id": job.id,
        "name": job.name,
        "enabled": bool(job.enabled),
        "schedule": {
            "kind": sched.kind,
            "at_ms": getattr(sched, "at_ms", None),
            "every_ms": getattr(sched, "every_ms", None),
            "expr": getattr(sched, "expr", None),
            "tz": getattr(sched, "tz", None),
        },
        "payload": {
            "kind": payload.kind,
            "message": payload.message,
            "deliver": payload.deliver,
            "channel": payload.channel,
            "to": payload.to,
            "channel_meta": dict(getattr(payload, "channel_meta", None) or {}),
            "session_key": getattr(payload, "session_key", None),
        },
        "state": {
            "next_run_at_ms": state.next_run_at_ms,
            "last_run_at_ms": state.last_run_at_ms,
            "last_status": state.last_status,
            "last_error": state.last_error,
        },
        "created_at_ms": int(getattr(job, "created_at_ms", 0) or 0),
        "updated_at_ms": int(getattr(job, "updated_at_ms", 0) or 0),
        "delete_after_run": bool(getattr(job, "delete_after_run", False)),
    }


def cron_history_for_job(job: Any) -> list[dict[str, Any]]:
    """Build the public history-run payloads for a single job.

    Each record echoes the job snapshot + decoded message metadata so the
    client can show "which agent ran with which prompt" without further
    server hops.
    """
    state = job.state
    runs = list(getattr(state, "run_history", []) or [])
    if not runs:
        return []
    meta = decode_cron_message(getattr(job.payload, "message", "") or "")
    out: list[dict[str, Any]] = []
    for r in runs:
        per_run = getattr(r, "prompt", None)
        prompt = (
            per_run.strip()
            if isinstance(per_run, str) and per_run.strip()
            else meta.prompt
        )
        out.append(
            {
                "run_at_ms": int(r.run_at_ms),
                "status": str(r.status),
                "duration_ms": float(getattr(r, "duration_ms", 0) or 0),
                "error": getattr(r, "error", None),
                "job_id": job.id,
                "job_name": job.name,
                "agent_id": meta.agent_id,
                "skills": list(meta.skills),
                "mcp_servers": list(meta.mcp_servers),
                "tools": list(meta.tools),
                "prompt": prompt,
                "deliver": job.payload.deliver,
                "channel": job.payload.channel,
                "to": job.payload.to,
            }
        )
    return out
