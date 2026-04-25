"""FastAPI application factory and lifecycle management.

This module is the single entry point for the consolidated OpenPawlet
console.  In addition to the historical REST API + SPA hosting it now
also owns the embedded nanobot runtime (agent loop, channels, cron,
heartbeat) via :mod:`nanobot.runtime.embedded`, the OpenAI-compatible
``/v1/*`` surface and the ``/queues/*`` admin endpoints.  External
clients therefore only ever need to talk to one HTTP port.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import websockets
import websockets.exceptions
from fastapi import FastAPI, Request, WebSocket, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from loguru import logger

from console.server.config import ServerSettings, get_settings
from console.server.models import ErrorDetail, ErrorResponse
from console.server.openai_api import install_openai_routes
from console.server.queue_envelope import tag_inbound_text_frame
from console.server.queues_router import install_queues_routes
from console.server.routers import v1

_ERR_VALIDATION_CODE = "VALIDATION_ERROR"
_ERR_VALIDATION_MSG = "Request validation failed"
_ERR_INTERNAL_CODE = "INTERNAL_ERROR"
_ERR_INTERNAL_MSG = "An unexpected error occurred"


def _embedded_disabled() -> bool:
    """Return True when the embedded nanobot runtime should not be started.

    Tests use this escape hatch to mount the FastAPI app without paying
    the cost of constructing the full agent + channels graph.
    """
    return os.environ.get("OPENPAWLET_DISABLE_EMBEDDED", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


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

    embedded = None
    if not _embedded_disabled():
        try:
            from nanobot.runtime.embedded import EmbeddedNanobot

            embedded = EmbeddedNanobot.from_environment()
        except Exception:  # noqa: BLE001 - degraded mode keeps the UI usable
            logger.exception(
                "Failed to construct embedded nanobot runtime; "
                "console will start in degraded mode"
            )
        else:
            try:
                await embedded.start()
                app.state.embedded = embedded
                app.state.agent_loop = embedded.agent
                app.state.message_bus = embedded.message_bus
                app.state.session_manager = embedded.session_manager
                app.state.model_name = embedded.agent.model
            except Exception:  # noqa: BLE001 - keep API alive even if runtime fails
                logger.exception(
                    "Embedded nanobot runtime failed to start; degraded mode"
                )
                embedded = None

    try:
        yield
    finally:
        if embedded is not None:
            try:
                await embedded.stop()
            except Exception:  # pragma: no cover - best effort shutdown
                logger.exception("Embedded nanobot runtime shutdown failed")
        logger.info("Shutting down OpenPawlet console server")


def _error_json(
    status_code: int,
    *,
    code: str,
    message: str,
    detail: dict[str, Any] | None = None,
) -> JSONResponse:
    """Serialize the standard error envelope to JSON."""
    return JSONResponse(
        status_code=status_code,
        content=ErrorResponse(
            error=ErrorDetail(code=code, message=message, detail=detail)
        ).model_dump(mode="json"),
    )


async def validation_exception_handler(
    _request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """422 for request body / parameter validation failures."""
    return _error_json(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        code=_ERR_VALIDATION_CODE,
        message=_ERR_VALIDATION_MSG,
        detail={"errors": exc.errors()},
    )


async def unhandled_exception_handler(
    _request: Request,
    _exc: Exception,
) -> JSONResponse:
    """500 for uncaught exceptions."""
    logger.exception("Unhandled exception")
    return _error_json(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        code=_ERR_INTERNAL_CODE,
        message=_ERR_INTERNAL_MSG,
    )


def _spa_dist_dir() -> Path:
    """Return the path to the bundled SPA ``dist`` directory."""
    return Path(__file__).resolve().parents[1] / "web" / "dist"


def _mount_spa(app: FastAPI) -> bool:
    """Mount the prebuilt SPA on ``app``. Returns True when assets were found."""
    dist = _spa_dist_dir()
    index = dist / "index.html"
    if not index.is_file():
        logger.warning(
            "[spa] dist not found at {}; run "
            "'npm --prefix src/console/web run build' first.",
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


def _ws_close_label(exc: BaseException) -> str:
    """Compact human-readable tag for a websockets ``ConnectionClosed``."""
    code = getattr(exc, "code", None)
    reason = getattr(exc, "reason", "") or ""
    if code is None:
        return type(exc).__name__
    return f"code={code} reason={reason!r}" if reason else f"code={code}"


async def _nanobot_ws_proxy(
    websocket: WebSocket,
    rest_path: str,
    gateway_host: str,
    gateway_port: int,
) -> None:
    """Bidirectionally proxy a WebSocket connection to the in-process nanobot WS channel.

    The embedded ``WebSocketChannel`` listens on a loopback port inside
    the same process and event loop, so this is a same-origin hop rather
    than a cross-process round trip.
    """
    await websocket.accept()

    raw_qs = websocket.scope.get("query_string", b"")
    query_string = raw_qs.decode() if isinstance(raw_qs, bytes) else str(raw_qs)
    target_path = f"/{rest_path}" if rest_path else "/"
    target_url = f"ws://{gateway_host}:{gateway_port}{target_path}"
    if query_string:
        target_url = f"{target_url}?{query_string}"

    client_addr = websocket.client
    logger.debug(
        "[nanobot-ws-proxy] open client={} -> {}:{}{}",
        client_addr,
        gateway_host,
        gateway_port,
        target_path,
    )

    try:
        async with websockets.connect(target_url) as remote_ws:

            async def _client_to_remote() -> None:
                try:
                    while True:
                        frame = await websocket.receive()
                        if frame.get("type") == "websocket.disconnect":
                            break
                        text = frame.get("text")
                        data = frame.get("bytes")
                        if text is not None:
                            tagged = tag_inbound_text_frame(text)
                            await remote_ws.send(tagged)
                        elif data is not None:
                            await remote_ws.send(data)
                except websockets.exceptions.ConnectionClosed:
                    pass
                except Exception as exc:  # noqa: BLE001 - close both sides
                    logger.warning(
                        "[nanobot-ws-proxy] client->gateway error: {}", exc
                    )
                finally:
                    await remote_ws.close()

            async def _remote_to_client() -> None:
                try:
                    async for message in remote_ws:
                        if isinstance(message, str):
                            await websocket.send_text(message)
                        else:
                            await websocket.send_bytes(message)
                except websockets.exceptions.ConnectionClosed:
                    pass
                except Exception as exc:  # noqa: BLE001
                    logger.warning(
                        "[nanobot-ws-proxy] gateway->client error: {}", exc
                    )
                finally:
                    try:
                        await websocket.close()
                    except Exception:  # pragma: no cover
                        pass

            tasks = [
                asyncio.create_task(_client_to_remote()),
                asyncio.create_task(_remote_to_client()),
            ]
            _, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
                except Exception:  # pragma: no cover
                    pass

    except OSError as exc:
        logger.warning(
            "[nanobot-ws-proxy] cannot reach embedded gateway at ws://{}:{}{}: {}",
            gateway_host,
            gateway_port,
            target_path,
            exc,
        )
        try:
            await websocket.close(code=1014)
        except Exception:  # pragma: no cover
            pass
    except Exception as exc:  # noqa: BLE001
        logger.exception(
            "[nanobot-ws-proxy] unexpected proxy error: {}", exc
        )
        try:
            await websocket.close(code=1011)
        except Exception:  # pragma: no cover
            pass


def _mount_nanobot_ws_proxy(
    app: FastAPI, gateway_host: str, gateway_port: int
) -> None:
    """Register the ``/nanobot-ws/`` WebSocket reverse-proxy route on *app*."""

    @app.websocket("/nanobot-ws/{rest_path:path}")
    async def nanobot_ws_proxy_route(websocket: WebSocket, rest_path: str) -> None:
        await _nanobot_ws_proxy(websocket, rest_path, gateway_host, gateway_port)

    logger.info(
        "[nanobot-ws-proxy] Proxying /nanobot-ws/* -> ws://{}:{} (in-process loopback)",
        gateway_host,
        gateway_port,
    )


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
        version=settings.version,
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
    install_openai_routes(app, model_name="nanobot")
    install_queues_routes(app)

    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # Register WS proxy before the SPA catch-all so the path isn't swallowed.
    # The "gateway" now lives in the same process via EmbeddedNanobot, but the
    # underlying WebSocketChannel still binds a loopback port for protocol
    # fidelity, so we proxy same-origin to it.
    _mount_nanobot_ws_proxy(
        app, settings.nanobot_gateway_host, settings.nanobot_gateway_port
    )

    spa_mounted = _mount_spa(app) if mount_spa else False

    if not spa_mounted:

        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, str]:
            return {"service": settings.title, "version": settings.version}

    return app
