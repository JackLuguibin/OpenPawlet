"""Workspace file browser models."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict


class WorkspaceListItem(BaseModel):
    """File or directory entry."""

    model_config = ConfigDict(extra="forbid")

    name: str
    path: str
    is_dir: bool
    children: list[Any] | None = None


class WorkspaceListResponse(BaseModel):
    """GET /workspace/files."""

    model_config = ConfigDict(extra="forbid")

    path: str
    items: list[WorkspaceListItem]


class WorkspaceFileResponse(BaseModel):
    """GET /workspace/file."""

    model_config = ConfigDict(extra="forbid")

    path: str
    content: str


class WorkspaceFilePutBody(BaseModel):
    """PUT /workspace/file body."""

    model_config = ConfigDict(extra="forbid")

    path: str
    content: str
