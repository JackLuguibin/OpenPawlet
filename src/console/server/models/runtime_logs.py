"""Runtime log file tail API models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class RuntimeLogChunk(BaseModel):
    """One log file slice returned to the console UI."""

    model_config = ConfigDict(extra="forbid")

    source: Literal["console"]
    path: str = Field(description="Absolute path on the server host")
    text: str = Field(description="UTF-8 tail text (may be empty)")
    exists: bool = Field(description="Whether the file exists")
    truncated: bool = Field(
        default=False,
        description="True when older history remains and can be paged in",
    )
    has_more: bool = Field(
        default=False,
        description="Whether there are older log lines available",
    )
    next_cursor: str | None = Field(
        default=None,
        description="Cursor token for fetching older lines",
    )


class RuntimeLogsData(BaseModel):
    """Bundled tails for console log files."""

    model_config = ConfigDict(extra="forbid")

    chunks: list[RuntimeLogChunk]
