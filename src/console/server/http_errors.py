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
    "not_found",
    "unprocessable",
]


def bad_request(detail: Any = "Bad request") -> NoReturn:
    """Raise ``HTTPException(400)`` with *detail*."""
    raise HTTPException(status_code=400, detail=detail)


def forbidden(detail: Any = "Forbidden") -> NoReturn:
    """Raise ``HTTPException(403)`` with *detail*."""
    raise HTTPException(status_code=403, detail=detail)


def not_found(what: str = "Resource") -> NoReturn:
    """Raise ``HTTPException(404)`` for the named resource."""
    raise HTTPException(status_code=404, detail=f"{what} not found")


def conflict(detail: Any = "Conflict") -> NoReturn:
    """Raise ``HTTPException(409)`` with *detail*."""
    raise HTTPException(status_code=409, detail=detail)


def unprocessable(detail: Any = "Unprocessable entity") -> NoReturn:
    """Raise ``HTTPException(422)`` with *detail*."""
    raise HTTPException(status_code=422, detail=detail)
