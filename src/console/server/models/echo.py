"""Echo test endpoint models."""

from __future__ import annotations

from typing import Any

from pydantic import Field

from console.server.models.base import BaseResponse


class EchoRequest(BaseResponse):
    """Test endpoint — mirrors the request body back."""

    content: str = Field(description="Text content to echo back")
    metadata: dict[str, Any] | None = Field(default=None)


class EchoResponse(BaseResponse):
    """Echo endpoint response."""

    content: str
    metadata: dict[str, Any] | None = None
