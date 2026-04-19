"""Structured error response models."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from console.server.models.base import BaseResponse


class ErrorDetail(BaseResponse):
    """Structured error detail."""

    code: str = Field(description="Machine-readable error code")
    message: str = Field(description="Human-readable error message")
    detail: dict[str, Any] | None = Field(default=None, description="Extra context")


class ErrorResponse(BaseResponse):
    """Standard error response body."""

    error: ErrorDetail
