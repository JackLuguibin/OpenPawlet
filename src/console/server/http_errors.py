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
    "gone",
    "internal_error",
    "not_found",
    "not_found_detail",
    "service_unavailable",
    "unprocessable",
]


def _raise(
    status_code: int,
    detail: Any,
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    exc = HTTPException(status_code=status_code, detail=detail)
    if cause is not None:
        raise exc from cause
    raise exc


def bad_request(
    detail: Any = "Bad request",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(400)`` with *detail*."""
    _raise(400, detail, cause=cause)


def forbidden(
    detail: Any = "Forbidden",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(403)`` with *detail*."""
    _raise(403, detail, cause=cause)


def not_found(what: str = "Resource") -> NoReturn:
    """Raise ``HTTPException(404)`` for the named resource."""
    _raise(404, f"{what} not found")


def not_found_detail(
    detail: str,
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(404)`` with an explicit *detail* message."""
    _raise(404, detail, cause=cause)


def gone(
    detail: Any = "Resource is no longer available",
) -> NoReturn:
    """Raise ``HTTPException(410)`` — resource removed, use alternate API."""
    _raise(410, detail)


def conflict(detail: Any = "Conflict") -> NoReturn:
    """Raise ``HTTPException(409)`` with *detail*."""
    _raise(409, detail)


def unprocessable(detail: Any = "Unprocessable entity") -> NoReturn:
    """Raise ``HTTPException(422)`` with *detail*."""
    _raise(422, detail)


def internal_error(
    detail: Any = "Internal server error",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(500)`` with *detail*.

    Pass *cause* to preserve exception chaining (equivalent to ``raise ... from cause``).
    """
    _raise(500, detail, cause=cause)


def service_unavailable(
    detail: Any = "Service unavailable",
    *,
    cause: BaseException | None = None,
) -> NoReturn:
    """Raise ``HTTPException(503)`` with *detail*."""
    _raise(503, detail, cause=cause)
