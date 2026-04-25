"""Chat sessions backed by nanobot workspace ``sessions/*.jsonl``."""

from __future__ import annotations

from collections.abc import Callable
import re
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query

from console.server.bot_workspace import (
    iso_now,
    load_json_file,
    new_id,
    save_active_team_gateway,
    save_json_file,
    teams_state_path,
)
from console.server.models import (
    BatchDeleteBody,
    BatchDeleteFailure,
    BatchDeleteResponse,
    CreateSessionBody,
    DataResponse,
    OkBody,
    SessionContextEntry,
    SessionContextPayload,
    SessionDetail,
    SessionInfo,
    SessionJsonlRawPayload,
)
from console.server.models.sessions import Message, SessionMessagesPayload
from console.server.session_store import (
    delete_session_files,
    list_session_rows,
    load_context_entries,
    load_session,
    load_transcript_messages,
    read_context_jsonl_raw,
    read_session_jsonl_raw,
    read_transcript_jsonl_raw,
    save_empty_session,
)
from nanobot.utils.team_gateway_runtime import team_member_session_key

router = APIRouter(tags=["Sessions"])

_READ_JSONL_RAW: dict[
    Literal["session", "transcript"],
    Callable[[str | None, str], str | None],
] = {
    "session": read_session_jsonl_raw,
    "transcript": read_transcript_jsonl_raw,
}

_PREVIEW_LIMIT = 8
_TEAM_SESSION_RE = re.compile(
    r"^console:team_(?P<team_id>[^_]+)_room_(?P<room_id>[^_]+)_agent_(?P<agent_id>.+?)(?:_run_[^_]+)?$"
)


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
    key = str(row["key"])
    team_id = room_id = agent_id = None
    match = _TEAM_SESSION_RE.match(key)
    if match:
        team_id = match.group("team_id")
        room_id = match.group("room_id")
        agent_id = match.group("agent_id")
    return SessionInfo(
        key=key,
        title=None,
        message_count=int(row["message_count"]),
        last_message=None,
        created_at=str(ca) if ca is not None else None,
        updated_at=str(ua) if ua is not None else None,
        team_id=team_id,
        room_id=room_id,
        agent_id=agent_id,
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


def _team_member_ephemeral_enabled(
    bot_id: str | None,
    team_id: str,
    agent_id: str,
) -> bool:
    if not bot_id:
        return False
    raw = load_json_file(teams_state_path(bot_id), None)
    if not isinstance(raw, dict):
        return False
    teams = raw.get("teams")
    if not isinstance(teams, list):
        return False
    row = next(
        (
            item
            for item in teams
            if isinstance(item, dict) and str(item.get("id", "")).strip() == team_id
        ),
        None,
    )
    if not isinstance(row, dict):
        return False
    flags = row.get("member_ephemeral")
    if not isinstance(flags, dict):
        return False
    return bool(flags.get(agent_id))


def _rotate_team_room_for_deleted_team_session(
    bot_id: str | None,
    session_key: str,
) -> None:
    """Create a fresh room and move active gateway before deleting a team session."""
    if not bot_id:
        return
    match = _TEAM_SESSION_RE.match(session_key)
    if not match:
        return
    team_id = match.group("team_id")
    room_id = match.group("room_id")
    path = teams_state_path(bot_id)
    raw = load_json_file(path, None)
    if not isinstance(raw, dict):
        return
    teams = raw.get("teams")
    rooms = raw.get("rooms")
    if not isinstance(teams, list) or not isinstance(rooms, list):
        return
    if not any(
        isinstance(item, dict) and str(item.get("id", "")).strip() == team_id
        for item in teams
    ):
        return
    if not any(
        isinstance(item, dict)
        and str(item.get("team_id", "")).strip() == team_id
        and str(item.get("id", "")).strip() == room_id
        for item in rooms
    ):
        return
    next_room_id = new_id("room-")
    rooms.append(
        {
            "id": next_room_id,
            "team_id": team_id,
            "created_at": iso_now(),
        }
    )
    save_json_file(path, {**raw, "teams": teams, "rooms": rooms})
    save_active_team_gateway(bot_id, team_id, next_room_id)


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


def _paginate_transcript_window(
    messages: list,
    limit: int | None,
    before_index: int | None,
) -> tuple[list, int, int, bool]:
    """Return ``(window, offset, total, has_more)`` for a transcript slice.

    - ``limit``/``before_index`` are optional; when neither is provided the
      full list is returned and ``has_more`` is ``False`` (legacy shape).
    - ``before_index`` is the absolute index reported by a previous response
      (i.e. the caller's current oldest ``offset``); the returned window is
      the ``limit`` messages immediately preceding that index.
    - Without ``before_index`` the newest ``limit`` messages are returned.
    """
    total = len(messages)
    if limit is None and before_index is None:
        return messages, 0, total, False

    end = total if before_index is None else max(0, min(before_index, total))
    if limit is None or limit <= 0:
        return messages[:end], 0, total, False

    start = max(0, end - limit)
    return messages[start:end], start, total, start > 0


@router.get(
    "/sessions/{session_key}/transcript",
    response_model=DataResponse[SessionMessagesPayload],
)
async def get_session_transcript(
    session_key: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
    limit: int | None = Query(default=None, ge=1, le=5000),
    before_index: int | None = Query(
        default=None, alias="before_index", ge=0,
    ),
) -> DataResponse[SessionMessagesPayload]:
    """Load chat history from append-only transcript JSONL (full verbatim log).

    Falls back to ``sessions/*.jsonl`` when no transcript file exists (older runs
    without ``persist_session_transcript``).

    When ``limit`` is supplied, the most recent ``limit`` messages are returned
    (or, if ``before_index`` is also provided, the ``limit`` messages ending
    immediately before that absolute index). The response carries the absolute
    ``offset`` of the first returned message along with the transcript ``total``
    and a ``has_more`` flag so the client can lazily page older history. When
    neither parameter is provided the full transcript is returned (legacy
    behaviour) and pagination fields are omitted / ``False``.
    """
    tmsgs = load_transcript_messages(bot_id, session_key)
    if tmsgs is None:
        session = load_session(bot_id, session_key)
        if session is None:
            raise HTTPException(status_code=404, detail="Session not found")
        tmsgs = session.messages

    window, offset, total, has_more = _paginate_transcript_window(
        tmsgs, limit, before_index,
    )
    paginated = limit is not None or before_index is not None
    return DataResponse(
        data=SessionMessagesPayload(
            key=session_key,
            messages=window,
            message_count=len(window),
            offset=offset if paginated else None,
            total=total if paginated else None,
            has_more=has_more,
        )
    )


@router.get(
    "/sessions/{session_key}/context",
    response_model=DataResponse[SessionContextPayload],
)
async def get_session_context(
    session_key: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
) -> DataResponse[SessionContextPayload]:
    """Return the latest assembled-context snapshot for *session_key*.

    Reads ``<workspace>/context/{safe_key}.jsonl``, which ``SessionContextWriter``
    overwrites at the start of each agent turn with the prompt that is about to
    be sent to the LLM.  The record contains both a rendered ``context_text``
    and the structured ``messages`` so the console can display the real prompt
    (system + bootstrap files + memory + history) without re-running the
    context builder.  If older appended files still carry multiple lines, the
    last line is used as the current snapshot for backwards compatibility.
    """
    entries_raw = load_context_entries(bot_id, session_key)
    if entries_raw is None:
        raise HTTPException(status_code=404, detail="Session context not found")

    latest = (
        SessionContextEntry.model_validate(entries_raw[-1]) if entries_raw else None
    )
    text = read_context_jsonl_raw(bot_id, session_key) or ""
    return DataResponse(
        data=SessionContextPayload(
            key=session_key,
            latest=latest,
            text=text,
        )
    )


@router.get(
    "/sessions/{session_key}/jsonl-raw",
    response_model=DataResponse[SessionJsonlRawPayload],
)
async def get_session_jsonl_raw(
    session_key: str,
    bot_id: str | None = Query(default=None, alias="bot_id"),
    source: Literal["session", "transcript"] = Query(default="session"),
) -> DataResponse[SessionJsonlRawPayload]:
    """Return the raw on-disk JSONL for the session store or the append-only transcript file."""
    text = _READ_JSONL_RAW[source](bot_id, session_key)
    if text is None:
        _detail = {
            "session": "Session JSONL not found",
            "transcript": "Transcript JSONL not found",
        }[source]
        raise HTTPException(status_code=404, detail=_detail)
    return DataResponse(
        data=SessionJsonlRawPayload(
            key=session_key,
            source=source,
            text=text,
        )
    )


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
    tid = (body.team_id or "").strip()
    rid = (body.room_id or "").strip()
    aid = (body.agent_id or "").strip()
    ephemeral = bool(body.ephemeral_session or False)
    if tid and rid and aid and body.ephemeral_session is None:
        ephemeral = _team_member_ephemeral_enabled(bot_id, tid, aid)
    if raw:
        key = raw
    elif tid and rid and aid:
        if ephemeral:
            key = team_member_session_key(tid, rid, aid, nonce=str(uuid4()))
        else:
            key = team_member_session_key(tid, rid, aid)
    else:
        key = str(uuid4())
    session = save_empty_session(bot_id, key)
    team_id = room_id = agent_id = None
    match = _TEAM_SESSION_RE.match(key)
    if match:
        team_id = match.group("team_id")
        room_id = match.group("room_id")
        agent_id = match.group("agent_id")
    return DataResponse(
        data=SessionInfo(
            key=key,
            title=None,
            message_count=len(session.messages),
            last_message=None,
            created_at=_iso(session.created_at),
            updated_at=_iso(session.updated_at),
            team_id=team_id,
            room_id=room_id,
            agent_id=agent_id,
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
    if load_session(bot_id, session_key) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    _rotate_team_room_for_deleted_team_session(bot_id, session_key)
    if not delete_session_files(bot_id, session_key):
        raise HTTPException(status_code=404, detail="Session not found")
    return DataResponse(data=OkBody())
