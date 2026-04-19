"""FastAPI application factory and lifecycle management."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
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


def create_app(settings: ServerSettings | None = None) -> FastAPI:
    """Build and return a fully-configured FastAPI application instance.

    Args:
        settings: Optional pre-built settings object. If omitted the
            singleton from ``get_settings()`` is used.

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

    @app.get("/", include_in_schema=False)
    async def root() -> dict[str, str]:
        return {"service": settings.title, "version": settings.version}

    return app
