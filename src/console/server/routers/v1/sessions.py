"""Chat sessions backed by nanobot workspace ``sessions/*.jsonl``."""

from __future__ import annotations

from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query

from console.server.models import (
    BatchDeleteBody,
    BatchDeleteFailure,
    BatchDeleteResponse,
    CreateSessionBody,
    DataResponse,
    OkBody,
    SessionDetail,
    SessionInfo,
)
from console.server.models.sessions import Message, SessionMessagesPayload
from console.server.session_store import (
    delete_session_files,
    list_session_rows,
    load_session,
    save_empty_session,
)

router = APIRouter(tags=["Sessions"])

_PREVIEW_LIMIT = 8


def _iso(dt: object | None) -> str | None:
    """Format datetime or other value as string for API responses."""
    if dt is None:
        return None
    iso = getattr(dt, "isoformat", None)
    if callable(iso):
        return iso()
    return str(dt)


def _row_to_session_info(row: dict[str, object]) -> SessionInfo:
    ca = row.get("created_at")
    ua = row.get("updated_at")
    return SessionInfo(
        key=str(row["key"]),
        title=None,
        message_count=int(row["message_count"]),
        last_message=None,
        created_at=str(ca) if ca is not None else None,
        updated_at=str(ua) if ua is not None else None,
    )


def _preview_message_from_raw(raw: dict[str, object]) -> Message | None:
    role = raw.get("role")
    if role not in ("user", "assistant", "system", "tool"):
        return None
    content_val = raw.get("content", "")
    if isinstance(content_val, str):
        content = content_val
    else:
        content = "" if content_val is None else str(content_val)
    tc = raw.get("tool_call_id")
    tool_call_id = str(tc) if tc is not None else None
    ts = raw.get("timestamp")
    timestamp = str(ts) if ts is not None else None
    src = raw.get("source")
    source = str(src) if src is not None else None
    return Message(
        role=role,
        content=content,
        tool_call_id=tool_call_id,
        tool_name=None,
        timestamp=timestamp,
        source=source,
    )


@router.delete("/sessions/batch", response_model=DataResponse[BatchDeleteResponse])
async def delete_sessions_batch(
    body: BatchDeleteBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[BatchDeleteResponse]:
    """Batch delete sessions on disk."""
    deleted: list[str] = []
    failed: list[BatchDeleteFailure] = []
    for key in body.keys:
        try:
            if delete_session_files(bot_id, key):
                deleted.append(key)
            else:
                failed.append(BatchDeleteFailure(key=key, error="Session not found"))
        except OSError as exc:
            failed.append(BatchDeleteFailure(key=key, error=str(exc)))
    return DataResponse(data=BatchDeleteResponse(deleted=deleted, failed=failed))


@router.get("/sessions", response_model=DataResponse[list[SessionInfo]])
async def list_sessions(
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[list[SessionInfo]]:
    """List sessions from ``<workspace>/sessions``."""
    rows = list_session_rows(bot_id)
    return DataResponse(data=[_row_to_session_info(r) for r in rows])


@router.post("/sessions", response_model=DataResponse[SessionInfo])
async def create_session(
    body: CreateSessionBody,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[SessionInfo]:
    """Create an empty session file (or return existing if already present)."""
    raw = (body.key or "").strip()
    key = raw or str(uuid4())
    session = save_empty_session(bot_id, key)
    return DataResponse(
        data=SessionInfo(
            key=key,
            title=None,
            message_count=len(session.messages),
            last_message=None,
            created_at=_iso(session.created_at),
            updated_at=_iso(session.updated_at),
        )
    )


@router.get(
    "/sessions/{session_key}",
    response_model=DataResponse[SessionDetail | SessionMessagesPayload],
)
async def get_session(
    session_key: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
    detail: bool = Query(default=False),
) -> DataResponse[SessionDetail | SessionMessagesPayload]:
    """Load session messages from JSONL."""
    session = load_session(bot_id, session_key)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    messages = session.messages
    if detail:
        previews: list[Message] = []
        for raw in messages[-_PREVIEW_LIMIT:]:
            if not isinstance(raw, dict):
                continue
            pm = _preview_message_from_raw(raw)
            if pm is not None:
                previews.append(pm)
        return DataResponse(
            data=SessionDetail(
                key=session_key,
                title=None,
                message_count=len(messages),
                last_message=None,
                created_at=_iso(session.created_at),
                updated_at=_iso(session.updated_at),
                preview_messages=previews,
            )
        )
    return DataResponse(
        data=SessionMessagesPayload(
            key=session_key,
            messages=messages,
            message_count=len(messages),
        )
    )


@router.delete("/sessions/{session_key}", response_model=DataResponse[OkBody])
async def delete_session(
    session_key: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[OkBody]:
    """Delete a session JSONL file."""
    if not delete_session_files(bot_id, session_key):
        raise HTTPException(status_code=404, detail="Session not found")
    return DataResponse(data=OkBody())
