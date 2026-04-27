"""Embedded-runtime startup/shutdown management for the FastAPI app.

The console server is the single process that hosts the SPA, the REST API,
the OpenAI-compatible surface and the embedded nanobot runtime.  This module
owns the runtime side of that lifecycle so ``app.py`` only has to wire it
into FastAPI's ``lifespan`` hook.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from loguru import logger

from console.server.config import ServerSettings
from console.server.state_hub import bind_state_hub_to_loop

_TRUTHY_ENV_VALUES = frozenset({"1", "true", "yes", "on"})
_EMBEDDED_DISABLE_ENV = "OPENPAWLET_DISABLE_EMBEDDED"

_RUNTIME_STATE_ATTRS: tuple[str, ...] = (
    "embedded",
    "agent_loop",
    "message_bus",
    "session_manager",
    "agent_manager",
)


def _env_flag(name: str, default: bool = False) -> bool:
    """Return True when ``$NAME`` is set to a truthy value."""
    raw = os.environ.get(name)
    if raw is None:
        return default
    return raw.strip().lower() in _TRUTHY_ENV_VALUES


def embedded_disabled() -> bool:
    """Return True when the embedded nanobot runtime should not be started."""
    return _env_flag(_EMBEDDED_DISABLE_ENV)


async def _build_embedded_runtime(app: FastAPI) -> Any | None:
    """Construct (but do not start) the embedded ``EmbeddedNanobot`` instance.

    Returns ``None`` and logs the failure when construction fails.
    """
    try:
        from console.server.nanobot_user_config import (
            ensure_full_config,
            resolve_config_path,
        )
        from nanobot.config.loader import set_config_path as _set_nanobot_config_path
        from nanobot.runtime.embedded import EmbeddedNanobot

        settings: ServerSettings = app.state.settings

        # When the console has an "active" non-default bot, retarget the
        # nanobot config loader at its per-bot config.json before
        # constructing the runtime.
        active_bot_id = getattr(app.state, "active_bot_id", None)
        if active_bot_id:
            from console.server.bots_registry import DEFAULT_BOT_ID, get_registry

            if active_bot_id != DEFAULT_BOT_ID:
                row = get_registry().get(active_bot_id)
                if row is not None:
                    _set_nanobot_config_path(Path(str(row["config_path"])))

        try:
            ensure_full_config(resolve_config_path(active_bot_id))
        except Exception:  # noqa: BLE001 - never block runtime over auto-fill
            logger.exception("[config] auto-fill of nanobot config failed; continuing")

        return EmbeddedNanobot.from_environment(
            websocket_host=settings.nanobot_gateway_host,
            websocket_port=settings.nanobot_gateway_port,
            websocket_path="/",
            websocket_requires_token=False,
        )
    except Exception:  # noqa: BLE001 - degraded mode keeps the UI usable
        logger.exception(
            "Failed to construct embedded nanobot runtime; console will start in degraded mode"
        )
        return None


def _attach_runtime_to_app(app: FastAPI, embedded: Any) -> None:
    """Publish the running ``embedded`` graph onto ``app.state``."""
    from nanobot.runtime.agent_manager import UnifiedAgentManager

    app.state.embedded = embedded
    app.state.agent_loop = embedded.agent
    app.state.message_bus = embedded.message_bus
    app.state.session_manager = embedded.session_manager
    app.state.model_name = embedded.agent.model
    app.state.agent_manager = UnifiedAgentManager(embedded)


def _detach_runtime_state(app: FastAPI) -> None:
    """Forget every per-runtime attribute on ``app.state``."""
    for attr in _RUNTIME_STATE_ATTRS:
        if hasattr(app.state, attr):
            delattr(app.state, attr)


async def start_embedded_runtime(app: FastAPI) -> Any | None:
    """Construct and start the embedded nanobot runtime.

    Returns the running ``EmbeddedNanobot`` on success, or ``None`` when the
    runtime could not be constructed or failed to start.  Either failure
    leaves the FastAPI app in degraded mode.
    """
    embedded = await _build_embedded_runtime(app)
    if embedded is None:
        return None

    try:
        await embedded.start()
    except Exception:  # noqa: BLE001 - keep API alive even if runtime fails
        logger.exception("Embedded nanobot runtime failed to start; degraded mode")
        return None

    _attach_runtime_to_app(app, embedded)
    return embedded


async def swap_runtime(app: FastAPI, bot_id: str) -> bool:
    """Stop the current embedded runtime and start a fresh one for *bot_id*.

    The console runs at most one runtime at a time (per-bot pooling requires
    multiple WebSocketChannel ports / cron stores; we use a main-vs-standby
    model for now).  Returns ``True`` when the new runtime started.
    """
    lock: asyncio.Lock = getattr(app.state, "runtime_swap_lock", None) or asyncio.Lock()
    app.state.runtime_swap_lock = lock
    async with lock:
        previous = getattr(app.state, "embedded", None)
        if previous is not None:
            try:
                await previous.stop()
            except Exception:  # pragma: no cover - best-effort teardown
                logger.exception("previous embedded runtime stop failed")
        _detach_runtime_state(app)
        app.state.active_bot_id = bot_id
        new_runtime = await start_embedded_runtime(app)
        return new_runtime is not None


def _ensure_active_bot_id(app: FastAPI) -> None:
    """Initialise ``app.state.active_bot_id`` from the bots registry."""
    if hasattr(app.state, "active_bot_id"):
        return
    from console.server.bots_registry import get_registry

    try:
        app.state.active_bot_id = get_registry().default_id()
    except Exception:  # pragma: no cover - registry should not raise
        app.state.active_bot_id = "default"


def _ensure_server_config() -> None:
    """Auto-fill any newly-introduced fields in ``nanobot_web.json`` once per boot."""
    try:
        from console.server.config import ensure_server_config

        ensure_server_config()
    except Exception:  # noqa: BLE001 - server settings already resolved above
        logger.exception("[config] auto-fill of nanobot_web.json failed; continuing")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Bring the embedded nanobot runtime up alongside the HTTP server."""
    settings: ServerSettings = app.state.settings
    logger.info(
        "Starting OpenPawlet console server {version} - listening on {host}:{port}",
        version=settings.version,
        host=settings.host,
        port=settings.port,
    )
    app.state.started_at_perf = time.perf_counter()
    # Bind the state-push hub to this loop so synchronous publishers
    # (request handlers, agent worker threads) can enqueue frames.
    bind_state_hub_to_loop(asyncio.get_running_loop())
    _ensure_active_bot_id(app)
    _ensure_server_config()

    if not embedded_disabled():
        await start_embedded_runtime(app)

    try:
        yield
    finally:
        embedded = getattr(app.state, "embedded", None)
        if embedded is not None:
            try:
                await embedded.stop()
            except Exception:  # pragma: no cover - best effort shutdown
                logger.exception("Embedded nanobot runtime shutdown failed")
        logger.info("Shutting down OpenPawlet console server")


__all__ = [
    "embedded_disabled",
    "start_embedded_runtime",
    "swap_runtime",
    "lifespan",
]
