"""Read tail of local ``~/.nanobot/logs`` files (nanobot gateway + console server)."""

from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Query

from console.server.models import DataResponse, RuntimeLogChunk, RuntimeLogsData
from console.server.runtime_log_read import default_runtime_log_path, read_tail_text

router = APIRouter(tags=["Runtime logs"])


@router.get(
    "/runtime-logs",
    response_model=DataResponse[RuntimeLogsData],
    summary="Tail of nanobot and console runtime log files",
)
async def runtime_logs(
    source: Annotated[
        Literal["all", "nanobot", "console"],
        Query(description="Which log stream(s) to return"),
    ] = "all",
    max_lines: Annotated[
        int,
        Query(ge=1, le=20000, alias="max_lines", description="Max lines per file"),
    ] = 2000,
) -> DataResponse[RuntimeLogsData]:
    """Return recent lines from rotating log files written by the gateway and console."""
    wanted: tuple[Literal["nanobot", "console"], ...]
    if source == "all":
        wanted = ("nanobot", "console")
    else:
        wanted = (source,)

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
                )
            )
            continue
        text, truncated = read_tail_text(path, max_lines=max_lines)
        chunks.append(
            RuntimeLogChunk(
                source=key,
                path=str(path.resolve()),
                text=text,
                exists=True,
                truncated=truncated,
            )
        )

    return DataResponse(data=RuntimeLogsData(chunks=chunks))
