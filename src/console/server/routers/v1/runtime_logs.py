"""Read tail of local ``~/.nanobot/logs`` files (console server)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query

from console.server.models import DataResponse, OkWithPath, RuntimeLogChunk, RuntimeLogsData
from console.server.runtime_log_read import default_runtime_log_path, read_log_page

router = APIRouter(tags=["Runtime logs"])


@router.get(
    "/runtime-logs",
    response_model=DataResponse[RuntimeLogsData],
    summary="Tail of console runtime log files",
)
async def runtime_logs(
    source: Annotated[
        Literal["all", "console"],
        Query(description="Which log stream(s) to return"),
    ] = "all",
    limit: Annotated[
        int,
        Query(ge=1, le=2000, description="Page size (lines per request)"),
    ] = 300,
    max_lines: Annotated[
        int | None,
        Query(ge=1, le=20000, alias="max_lines", description="Legacy alias of limit"),
    ] = None,
    cursor: Annotated[
        str | None,
        Query(description="Cursor from previous response to fetch older lines"),
    ] = None,
) -> DataResponse[RuntimeLogsData]:
    """Return paginated runtime log slices written by the console server."""
    # Keep ``source=all`` for backward compatibility; both values return console logs.
    wanted: tuple[Literal["console"], ...]
    if source == "all":
        wanted = ("console",)
    else:
        wanted = ("console",)

    page_limit = max_lines if max_lines is not None else limit
    chunks: list[RuntimeLogChunk] = []
    for key in wanted:
        path = default_runtime_log_path(key)
        exists = path.is_file()
        if not exists:
            chunks.append(
                RuntimeLogChunk(
                    source=key,
                    path=str(path.resolve()),
                    text="",
                    exists=False,
                    truncated=False,
                    has_more=False,
                    next_cursor=None,
                )
            )
            continue
        try:
            page = read_log_page(path, limit=page_limit, cursor_token=cursor)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        chunks.append(
            RuntimeLogChunk(
                source=key,
                path=str(path.resolve()),
                text=page.text,
                exists=True,
                truncated=page.truncated,
                has_more=page.has_more,
                next_cursor=page.next_cursor,
            )
        )

    return DataResponse(data=RuntimeLogsData(chunks=chunks))


@router.post(
    "/runtime-logs/clear",
    response_model=DataResponse[OkWithPath],
    summary="Clear console runtime log file",
)
async def clear_runtime_logs() -> DataResponse[OkWithPath]:
    """Truncate ``console.log`` in-place; create it if missing."""
    path = default_runtime_log_path("console")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("", encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status_code=500, detail="Failed to clear runtime log file") from exc
    return DataResponse(data=OkWithPath(path=str(path.resolve())))
