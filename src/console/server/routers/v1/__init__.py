"""Aggregate ``/api/v1`` routes (thin include-only module)."""

from __future__ import annotations

from fastapi import APIRouter

from . import (
    activity,
    agents,
    alerts,
    bot_files,
    bots,
    channels,
    chat,
    config,
    control,
    cron,
    env,
    health,
    health_audit,
    mcp,
    memory,
    sessions,
    skills,
    status,
    tools,
    usage,
    workspace,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(health_audit.router)
api_router.include_router(bots.router)
api_router.include_router(agents.router)
api_router.include_router(status.router)
api_router.include_router(usage.router)
api_router.include_router(channels.router)
api_router.include_router(mcp.router)
api_router.include_router(alerts.router)
api_router.include_router(sessions.router)
api_router.include_router(chat.router)
api_router.include_router(tools.router)
api_router.include_router(memory.router)
api_router.include_router(bot_files.router)
api_router.include_router(config.router)
api_router.include_router(skills.router)
api_router.include_router(env.router)
api_router.include_router(cron.router)
api_router.include_router(control.router)
api_router.include_router(workspace.router)
api_router.include_router(activity.router)
