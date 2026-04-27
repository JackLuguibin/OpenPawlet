"""Centralized FastAPI exception handlers used by the console server.

Wrapping every error in the same envelope (``ErrorResponse``) means the SPA
only has to special-case one shape; the OpenAI-compatible ``/v1/*`` routes
keep their own ``{error: {message, type, code}}`` format because external
SDKs depend on it.
"""

from __future__ import annotations

from typing import Any

from fastapi import FastAPI, HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from loguru import logger

from console.server.models import ErrorDetail, ErrorResponse

_ERR_VALIDATION_CODE = "VALIDATION_ERROR"
_ERR_VALIDATION_MSG = "Request validation failed"
_ERR_INTERNAL_CODE = "INTERNAL_ERROR"
_ERR_INTERNAL_MSG = "An unexpected error occurred"

_HTTP_STATUS_CODE_MAP: dict[int, str] = {
    400: "BAD_REQUEST",
    401: "UNAUTHORIZED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
    409: "CONFLICT",
    410: "GONE",
    413: "PAYLOAD_TOO_LARGE",
    415: "UNSUPPORTED_MEDIA_TYPE",
    422: "VALIDATION_ERROR",
    429: "RATE_LIMITED",
    500: "INTERNAL_ERROR",
    501: "NOT_IMPLEMENTED",
    503: "SERVICE_UNAVAILABLE",
    504: "GATEWAY_TIMEOUT",
}


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


def openai_error_response(
    status_code: int,
    message: str,
    *,
    err_type: str = "invalid_request_error",
) -> JSONResponse:
    """OpenAI-compatible error envelope used for ``/v1/*`` routes.

    Public so the OpenAI compat router can produce identical-shaped errors
    (matching the SDK contract) without re-inventing the wrapper.
    """
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "message": message,
                "type": err_type,
                "code": status_code,
            }
        },
    )


# Internal alias preserved for the request/exception handlers below.
_openai_error = openai_error_response


def _is_openai_compat_path(request: Request) -> bool:
    """Whether *request* targets the OpenAI-compatible surface."""
    return request.url.path.startswith("/v1/")


async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """422 for request body / parameter validation failures."""
    if _is_openai_compat_path(request):
        return _openai_error(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            _ERR_VALIDATION_MSG,
            "invalid_request_error",
        )
    return _error_json(
        status.HTTP_422_UNPROCESSABLE_ENTITY,
        code=_ERR_VALIDATION_CODE,
        message=_ERR_VALIDATION_MSG,
        detail={"errors": exc.errors()},
    )


async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    """Wrap ``HTTPException`` in the standard ``ErrorResponse`` envelope."""
    code = _HTTP_STATUS_CODE_MAP.get(exc.status_code, f"HTTP_{exc.status_code}")
    detail = exc.detail
    if _is_openai_compat_path(request):
        msg = detail if isinstance(detail, str) else "Request failed"
        return _openai_error(exc.status_code, msg, "invalid_request_error")
    if isinstance(detail, str):
        message = detail
        detail_payload: dict[str, Any] | None = None
    else:
        message = code.replace("_", " ").title()
        detail_payload = {"detail": detail}
    return _error_json(
        exc.status_code,
        code=code,
        message=message,
        detail=detail_payload,
    )


async def unhandled_exception_handler(
    request: Request,
    _exc: Exception,
) -> JSONResponse:
    """500 for uncaught exceptions."""
    logger.exception("Unhandled exception")
    if _is_openai_compat_path(request):
        return _openai_error(
            status.HTTP_500_INTERNAL_SERVER_ERROR,
            _ERR_INTERNAL_MSG,
            "server_error",
        )
    return _error_json(
        status.HTTP_500_INTERNAL_SERVER_ERROR,
        code=_ERR_INTERNAL_CODE,
        message=_ERR_INTERNAL_MSG,
    )


def install_error_handlers(app: FastAPI) -> None:
    """Register all standard exception handlers on *app*."""
    app.add_exception_handler(
        RequestValidationError,
        validation_exception_handler,  # type: ignore[arg-type]
    )
    app.add_exception_handler(HTTPException, http_exception_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_exception_handler)


__all__ = [
    "install_error_handlers",
    "openai_error_response",
    "validation_exception_handler",
    "http_exception_handler",
    "unhandled_exception_handler",
]
