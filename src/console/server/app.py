"""FastAPI application factory and lifecycle management."""

from __future__ import annotations

import asyncio
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
from console.server.routers import v1

_ERR_VALIDATION_CODE = "VALIDATION_ERROR"
_ERR_VALIDATION_MSG = "Request validation failed"
_ERR_INTERNAL_CODE = "INTERNAL_ERROR"
_ERR_INTERNAL_MSG = "An unexpected error occurred"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Log startup and shutdown; bind/version come from settings."""
    settings: ServerSettings = app.state.settings
    logger.info(
        "Starting OpenPawlet console server {version} — listening on {host}:{port}",
        version=settings.version,
        host=settings.host,
        port=settings.port,
    )
    yield
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

    # SPA fallback: serve any top-level static asset if it exists, otherwise
    # return index.html so client-side routing works on deep links.
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


async def _nanobot_ws_proxy(
    websocket: WebSocket,
    rest_path: str,
    gateway_host: str,
    gateway_port: int,
) -> None:
    """Bidirectionally proxy a WebSocket connection to the nanobot gateway.

    Strips the ``/nanobot-ws`` prefix and forwards all frames (text + binary)
    to ``ws://<gateway_host>:<gateway_port>/<rest_path>?<query>``.
    This mirrors what Vite's dev-server proxy does so the built SPA works the
    same way as the Vite dev mode without any frontend changes.
    """
    await websocket.accept()

    raw_qs = websocket.scope.get("query_string", b"")
    query_string = raw_qs.decode() if isinstance(raw_qs, bytes) else str(raw_qs)
    target_path = f"/{rest_path}" if rest_path else "/"
    target_url = f"ws://{gateway_host}:{gateway_port}{target_path}"
    if query_string:
        target_url = f"{target_url}?{query_string}"

    logger.debug("[nanobot-ws-proxy] {} → {}", websocket.client, target_url)

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
                            await remote_ws.send(text)
                        elif data is not None:
                            await remote_ws.send(data)
                except Exception:
                    pass
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
                except Exception:
                    pass
                finally:
                    try:
                        await websocket.close()
                    except Exception:
                        pass

            tasks = [
                asyncio.create_task(_client_to_remote()),
                asyncio.create_task(_remote_to_client()),
            ]
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass

    except OSError as exc:
        logger.warning(
            "[nanobot-ws-proxy] Cannot reach gateway at {}: {}",
            target_url,
            exc,
        )
        try:
            await websocket.close(code=1014)
        except Exception:
            pass
    except Exception as exc:
        logger.warning("[nanobot-ws-proxy] Unexpected error: {}", exc)
        try:
            await websocket.close(code=1011)
        except Exception:
            pass


def _mount_nanobot_ws_proxy(app: FastAPI, gateway_host: str, gateway_port: int) -> None:
    """Register the ``/nanobot-ws/`` WebSocket reverse-proxy route on *app*."""

    @app.websocket("/nanobot-ws/{rest_path:path}")
    async def nanobot_ws_proxy_route(websocket: WebSocket, rest_path: str) -> None:
        await _nanobot_ws_proxy(websocket, rest_path, gateway_host, gateway_port)

    logger.info(
        "[nanobot-ws-proxy] Proxying /nanobot-ws/* → ws://{}:{}",
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

    Returns:
        A ready-to-mount FastAPI app. Pass it to an ASGI server such as
        uvicorn (see ``console.cli.main``) or hypercorn.
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

    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, unhandled_exception_handler)

    # Register WS proxy before the SPA catch-all so the path isn't swallowed.
    _mount_nanobot_ws_proxy(app, settings.nanobot_gateway_host, settings.nanobot_gateway_port)

    spa_mounted = _mount_spa(app) if mount_spa else False

    if not spa_mounted:

        @app.get("/", include_in_schema=False)
        async def root() -> dict[str, str]:
            return {"service": settings.title, "version": settings.version}

    return app
