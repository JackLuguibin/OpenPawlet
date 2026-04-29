"""Tiny helpers for raising :class:`fastapi.HTTPException` consistently.

Routers used to scatter ``raise HTTPException(status_code=404, detail="...")``
calls everywhere; collecting them here makes the messages and status codes
discoverable, enables a one-line edit when we ever want to swap to richer
problem-details payloads, and keeps router code focused on business logic.
"""

from __future__ import annotations

from typing import Any, NoReturn

from fastapi import HTTPException

__all__ = [
    "bad_request",
    "conflict",
    "forbidden",
    "internal_error",
    "not_found",
    "not_found_detail",
    "service_unavailable",
    "unprocessable",
]


def bad_request(
    detail: Any = "Bad request",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(400)`` with *detail*."""
    exc = HTTPException(status_code=400, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc


def forbidden(
    detail: Any = "Forbidden",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(403)`` with *detail*."""
    exc = HTTPException(status_code=403, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc


def not_found(what: str = "Resource") -> NoReturn:
    """Raise ``HTTPException(404)`` for the named resource."""
    raise HTTPException(status_code=404, detail=f"{what} not found")


def not_found_detail(
    detail: str,
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(404)`` with an explicit *detail* message."""
    exc = HTTPException(status_code=404, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc


def conflict(detail: Any = "Conflict") -> NoReturn:
    """Raise ``HTTPException(409)`` with *detail*."""
    raise HTTPException(status_code=409, detail=detail)


def unprocessable(detail: Any = "Unprocessable entity") -> NoReturn:
    """Raise ``HTTPException(422)`` with *detail*."""
    raise HTTPException(status_code=422, detail=detail)


def internal_error(
    detail: Any = "Internal server error",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(500)`` with *detail*.

    Pass *cause* to preserve exception chaining (equivalent to ``raise ... from cause``).
    """
    exc = HTTPException(status_code=500, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc


def service_unavailable(
    detail: Any = "Service unavailable",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(503)`` with *detail*."""
    exc = HTTPException(status_code=503, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc
