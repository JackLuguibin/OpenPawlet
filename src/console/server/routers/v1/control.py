"""Control plane APIs.

Legacy ``/control/stop`` and ``/control/restart`` remain stubs for backward
compatibility. Runtime lifecycle management is exposed by the unified manager
endpoints under ``/control/agents/*`` (main + sub agents).
"""

from __future__ import annotations

import dataclasses
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request

from console.server.models import (
    DataResponse,
    OkBody,
    RuntimeAgentStatus,
    RuntimeControlResult,
    RuntimeSubagentStartBody,
)
from console.server.nanobot_user_config import BOT_ID_DESCRIPTION

router = APIRouter(tags=["Control"])


def _runtime_manager_or_503(request: Request) -> Any:
    """Return runtime manager from app state or raise 503 in degraded mode."""
    manager = getattr(request.app.state, "agent_manager", None)
    if manager is None:
        raise HTTPException(
            status_code=503,
            detail="Embedded runtime manager unavailable (degraded mode or disabled runtime).",
        )
    return manager


def _runtime_status_model(row: Any) -> RuntimeAgentStatus:
    """Convert runtime status dataclass/object to API model."""
    if dataclasses.is_dataclass(row):
        payload = dataclasses.asdict(row)
    else:
        payload = dict(getattr(row, "__dict__", {}))
    return RuntimeAgentStatus.model_validate(payload)


@router.post(
    "/control/stop",
    response_model=DataResponse[OkBody],
    deprecated=True,
    summary="Stop current task (stub; no-op)",
)
async def stop_current_task(
    bot_id: str | None = Query(default=None, alias="bot_id", description=BOT_ID_DESCRIPTION),
) -> DataResponse[OkBody]:
    """Return ``ok`` without stopping anything (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())


@router.post(
    "/control/restart",
    response_model=DataResponse[OkBody],
    deprecated=True,
    summary="Restart bot (stub; no-op)",
)
async def restart_bot(
    bot_id: str | None = Query(default=None, alias="bot_id", description=BOT_ID_DESCRIPTION),
) -> DataResponse[OkBody]:
    """Return ``ok`` without restarting anything (stub)."""
    _ = bot_id
    return DataResponse(data=OkBody())


@router.get(
    "/control/agents/status",
    response_model=DataResponse[list[RuntimeAgentStatus]],
    summary="List runtime statuses for main and subagents",
)
async def list_runtime_agents(request: Request) -> DataResponse[list[RuntimeAgentStatus]]:
    """Return runtime statuses for the unified manager."""
    manager = _runtime_manager_or_503(request)
    rows = [_runtime_status_model(row) for row in manager.list_statuses()]
    return DataResponse(data=rows)


@router.get(
    "/control/agents/{agent_id}/status",
    response_model=DataResponse[RuntimeAgentStatus],
    summary="Get runtime status for one agent",
)
async def get_runtime_agent_status(
    request: Request,
    agent_id: str,
) -> DataResponse[RuntimeAgentStatus]:
    """Return runtime status by `main`/main id or `sub:<task_id>`."""
    manager = _runtime_manager_or_503(request)
    row = manager.get_status(agent_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Runtime agent not found")
    return DataResponse(data=_runtime_status_model(row))


@router.post(
    "/control/agents/main/start",
    response_model=DataResponse[RuntimeControlResult],
    summary="Start main agent loop",
)
async def start_main_agent(request: Request) -> DataResponse[RuntimeControlResult]:
    """Start the primary agent loop when it is not running."""
    manager = _runtime_manager_or_503(request)
    try:
        changed = await manager.start_main()
    except RuntimeError as exc:
        # Raised when the embedded runtime is mid-shutdown; surface as 503
        # so the SPA can retry once the next runtime comes up.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    row = manager.get_status("main")
    if row is None:
        raise HTTPException(status_code=500, detail="Main agent status unavailable after start")
    return DataResponse(
        data=RuntimeControlResult(
            agent_id=row.agent_id,
            changed=changed,
            running=row.running,
            message="Main agent started." if changed else "Main agent already running.",
        )
    )


@router.post(
    "/control/agents/main/stop",
    response_model=DataResponse[RuntimeControlResult],
    summary="Stop main agent loop",
)
async def stop_main_agent(request: Request) -> DataResponse[RuntimeControlResult]:
    """Stop the primary agent loop when it is running."""
    manager = _runtime_manager_or_503(request)
    changed = await manager.stop_main()
    row = manager.get_status("main")
    if row is None:
        raise HTTPException(status_code=500, detail="Main agent status unavailable after stop")
    return DataResponse(
        data=RuntimeControlResult(
            agent_id=row.agent_id,
            changed=changed,
            running=row.running,
            message="Main agent stopped." if changed else "Main agent already stopped.",
        )
    )


@router.post(
    "/control/agents/sub/start",
    response_model=DataResponse[RuntimeControlResult],
    summary="Start a managed subagent",
)
async def start_subagent(
    request: Request,
    body: RuntimeSubagentStartBody,
) -> DataResponse[RuntimeControlResult]:
    """Create a managed subagent task (team_id is plain metadata)."""
    manager = _runtime_manager_or_503(request)
    try:
        sub_id = await manager.start_subagent(
            task=body.task,
            label=body.label,
            parent_agent_id=body.parent_agent_id,
            team_id=body.team_id,
            origin_channel=body.origin_channel or "api",
            origin_chat_id=body.origin_chat_id or "manager",
            session_key=body.session_key,
            profile_id=body.profile_id,
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    row = manager.get_status(sub_id)
    if row is None:
        raise HTTPException(status_code=500, detail="Subagent status unavailable after start")
    return DataResponse(
        data=RuntimeControlResult(
            agent_id=row.agent_id,
            changed=True,
            running=row.running,
            message="Subagent started.",
        )
    )


@router.post(
    "/control/agents/sub/{agent_id}/stop",
    response_model=DataResponse[RuntimeControlResult],
    summary="Stop a managed subagent",
)
async def stop_subagent(
    request: Request,
    agent_id: str,
) -> DataResponse[RuntimeControlResult]:
    """Stop one managed subagent by runtime id."""
    manager = _runtime_manager_or_503(request)
    changed = await manager.stop_subagent(agent_id)
    row = manager.get_status(agent_id)
    if row is None:
        normalized = agent_id if agent_id.startswith("sub:") else f"sub:{agent_id}"
        return DataResponse(
            data=RuntimeControlResult(
                agent_id=normalized,
                changed=changed,
                running=False,
                message="Subagent stopped." if changed else "Subagent not found or already stopped.",
            )
        )
    return DataResponse(
        data=RuntimeControlResult(
            agent_id=row.agent_id,
            changed=changed,
            running=row.running,
            message="Subagent stopped." if changed else "Subagent already stopped.",
        )
    )
