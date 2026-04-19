"""Workspace file browser backed by the nanobot workspace directory."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, HTTPException, Query

from console.server.bot_workspace import (
    normalize_workspace_rel_path,
    read_text,
    resolve_workspace_path,
    workspace_root,
    write_text,
)
from console.server.models import DataResponse
from console.server.models.base import OkWithPath
from console.server.models.workspace import (
    WorkspaceFilePutBody,
    WorkspaceFileResponse,
    WorkspaceListItem,
    WorkspaceListResponse,
)

router = APIRouter(tags=["Workspace"])

_SKIP_NAMES = frozenset({".git", "__pycache__", ".DS_Store"})


def _scan_dir(
    abs_dir: Path,
    rel_prefix: str,
    remaining: int,
) -> list[WorkspaceListItem]:
    """List directory entries; recurse into subdirs while ``remaining`` > 0."""
    items: list[WorkspaceListItem] = []
    try:
        entries = sorted(
            abs_dir.iterdir(),
            key=lambda p: (not p.is_dir(), p.name.lower()),
        )
    except PermissionError as exc:
        raise HTTPException(status_code=403, detail="Permission denied") from exc
    for entry in entries:
        if entry.name in _SKIP_NAMES:
            continue
        rel_child = f"{rel_prefix}/{entry.name}" if rel_prefix else entry.name
        is_dir = entry.is_dir()
        children: list[WorkspaceListItem] | None = None
        if is_dir and remaining > 0:
            children = _scan_dir(entry, rel_child, remaining - 1)
        items.append(
            WorkspaceListItem(
                name=entry.name,
                path=rel_child,
                is_dir=is_dir,
                children=children,
            )
        )
    return items


@router.get("/workspace/files", response_model=DataResponse[WorkspaceListResponse])
async def list_workspace_files(
    path: str | None = Query(default=None),
    depth: int | None = Query(default=None, ge=0, le=32),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[WorkspaceListResponse]:
    """List files under a path relative to the workspace root."""
    root = workspace_root(bot_id)
    rel_out = normalize_workspace_rel_path(path)
    if not rel_out:
        target = root
    else:
        target = resolve_workspace_path(bot_id, path, must_exist=True)
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")
    max_depth = 0 if depth is None else depth
    items = _scan_dir(target, rel_out, max_depth)
    return DataResponse(data=WorkspaceListResponse(path=rel_out, items=items))


@router.get("/workspace/file", response_model=DataResponse[WorkspaceFileResponse])
async def get_workspace_file(
    path: str = Query(...),
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[WorkspaceFileResponse]:
    """Read a text file relative to the workspace root."""
    target = resolve_workspace_path(bot_id, path, must_exist=True)
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory")
    rel = path.replace("\\", "/").lstrip("/")
    content = read_text(target)
    return DataResponse(data=WorkspaceFileResponse(path=rel, content=content))


@router.put("/workspace/file", response_model=DataResponse[OkWithPath])
async def update_workspace_file(
    body: WorkspaceFilePutBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkWithPath]:
    """Create or overwrite a file under the workspace root."""
    normalized = body.path.replace("\\", "/").lstrip("/")
    target = resolve_workspace_path(bot_id, normalized, must_exist=False)
    if target.is_dir():
        raise HTTPException(status_code=400, detail="Path is a directory")
    write_text(target, body.content)
    return DataResponse(data=OkWithPath(path=normalized))
