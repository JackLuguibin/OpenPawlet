"""Long-term memory and history under ``<workspace>/memory/`` (OpenPawlet workspace)."""

from __future__ import annotations

from fastapi import APIRouter, Query

from console.server.bot_workspace import read_memory_text
from console.server.models import DataResponse, MemoryResponse

router = APIRouter(tags=["Memory"])


@router.get("/memory", response_model=DataResponse[MemoryResponse])
async def get_memory(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[MemoryResponse]:
    """Return long-term memory and history (same files as OpenPawlet ``MemoryStore``)."""
    long_term = read_memory_text(bot_id, "long_term")
    history = read_memory_text(bot_id, "history")
    return DataResponse(data=MemoryResponse(long_term=long_term, history=history))
