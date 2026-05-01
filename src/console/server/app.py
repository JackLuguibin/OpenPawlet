"""FastAPI application factory and lifecycle management.

This module is the single entry point for the consolidated OpenPawlet
console.  In addition to the historical REST API + SPA hosting it now
also owns the embedded OpenPawlet runtime (agent loop, channels, cron,
heartbeat) via :mod:`openpawlet.runtime.embedded`, the OpenAI-compatible
``/v1/*`` surface and the ``/queues/*`` admin endpoints.  External
clients therefore only ever need to talk to one HTTP port.
"""

from __future__ import annotations

import time
from pathlib import Path

from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from console.server.config import ServerSettings, get_settings, openpawlet_distribution_version
from console.server.error_handlers import install_error_handlers
from console.server.lifespan import lifespan, swap_runtime  # noqa: F401  (re-exported)
from console.server.openai_api import install_openai_routes
from console.server.queues_router import install_queues_routes
from console.server.routers import v1
from console.server.ws_proxy import mount_openpawlet_ws_proxy
from console.server.ws_state import state_ws_handler


def _spa_dist_dir() -> Path:
    """Return the path to the bundled SPA ``dist`` directory."""
    return Path(__file__).resolve().parents[1] / "web" / "dist"


def _mount_spa(app: FastAPI) -> bool:
    """Mount the prebuilt SPA on ``app``. Returns True when assets were found."""
    dist = _spa_dist_dir()
    index = dist / "index.html"
    if not index.is_file():
        logger.warning(
            "[spa] dist not found at {}; run 'npm --prefix src/console/web run build' first.",
            dist,
        )
        return False

    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        app.mount(
            "/assets",
            StaticFiles(directory=assets_dir),
            name="spa-assets",
        )

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa_fallback(full_path: str) -> FileResponse:
        if full_path:
            candidate = (dist / full_path).resolve()
            try:
                candidate.relative_to(dist)
            except ValueError:
                return FileResponse(index)
            if candidate.is_file():
                return FileResponse(candidate)
        return FileResponse(index)

    logger.info("[spa] SPA mounted from {}", dist)
    return True


def create_app(
    settings: ServerSettings | None = None,
    *,
    mount_spa: bool = False,
) -> FastAPI:
    """Build and return a fully-configured FastAPI application instance.

    Args:
        settings: Optional pre-built settings object. If omitted the
            singleton from ``get_settings()`` is used.
        mount_spa: When True, serve the prebuilt SPA from
            ``src/console/web/dist`` and skip the JSON service-info root.
    """
    if settings is None:
        settings = get_settings()

    app = FastAPI(
        title=settings.title,
        description=settings.description,
        version=openpawlet_distribution_version(),
        lifespan=lifespan,
        docs_url=settings.effective_docs_url,
        redoc_url=settings.effective_redoc_url,
        openapi_url=settings.effective_openapi_url,
    )
    app.state.settings = settings
    app.state.started_at_perf = time.perf_counter()

    _wildcard_cors = any(o.strip() == "*" for o in settings.cors_origins)
    allow_credentials = settings.cors_allow_credentials and not _wildcard_cors
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=allow_credentials,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(v1.api_router, prefix=settings.api_prefix)
    install_openai_routes(app, model_name="openpawlet")
    install_queues_routes(app)

    install_error_handlers(app)

    # Register WS proxy before the SPA catch-all so the path isn't swallowed.
    # The "gateway" now lives in the same process via EmbeddedOpenPawlet, but the
    # underlying WebSocketChannel still binds a loopback port for protocol
    # fidelity, so we proxy same-origin to it. Host/port here are fallbacks only;
    # lifespan publishes ``app.state.openpawlet_runtime_snapshot`` before serving.
    mount_openpawlet_ws_proxy(
        app,
        settings.openpawlet_gateway_host,
        settings.openpawlet_gateway_port,
        list(settings.cors_origins),
    )

    # Server-driven state push channel.  Mounted before the SPA fallback so
    # the path is not swallowed by the catch-all.  See ``state_hub.py``
    # and ``ws_state.py`` for the protocol contract.
    @app.websocket("/ws/state")
    async def _ws_state_route(websocket: WebSocket) -> None:
        await state_ws_handler(websocket)

    spa_mounted = _mount_spa(app) if mount_spa else False

    if not spa_mounted:

        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, str]:
            return {
                "service": settings.title,
                "version": openpawlet_distribution_version(),
            }

    return app
