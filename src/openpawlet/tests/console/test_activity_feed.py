"""Tests for observability row → ActivityItem mapping."""

from __future__ import annotations

from console.server.activity_feed import observability_rows_to_activity_items


def _row(
    event: str,
    *,
    ts: float = 1_700_000_000.0,
    trace_id: str | None = "t1",
    session_key: str | None = "sess-a",
    payload: dict | None = None,
) -> dict:
    return {
        "ts": ts,
        "event": event,
        "trace_id": trace_id,
        "session_key": session_key,
        "payload": payload or {},
    }


def test_maps_llm_to_message() -> None:
    rows = [
        _row(
            "llm",
            payload={"kind": "chat", "model": "gpt-4", "iteration": 1, "wall_ms": 120.5},
        )
    ]
    items = observability_rows_to_activity_items(rows)
    assert len(items) == 1
    assert items[0].type == "message"
    assert "LLM" in items[0].title
    assert "gpt-4" in items[0].title
    assert items[0].metadata and items[0].metadata.get("source_event") == "llm"


def test_maps_tool_success_to_tool_call() -> None:
    rows = [
        _row(
            "tool",
            payload={
                "name": "read_file",
                "tool_call_id": "c1",
                "iteration": 0,
                "duration_ms": 5.0,
                "status": "ok",
            },
        )
    ]
    items = observability_rows_to_activity_items(rows)
    assert len(items) == 1
    assert items[0].type == "tool_call"
    assert "read_file" in items[0].title


def test_maps_tool_fail_status_to_error() -> None:
    rows = [
        _row(
            "tool",
            payload={
                "name": "bash",
                "tool_call_id": "c2",
                "iteration": 0,
                "duration_ms": 1.0,
                "status": "error",
                "detail": "exit 1",
            },
        )
    ]
    items = observability_rows_to_activity_items(rows)
    assert len(items) == 1
    assert items[0].type == "error"


def test_maps_run_start_end_to_session() -> None:
    rows = [
        _row("run_start", payload={}),
        _row("run_end", payload={"duration_ms": 99.0}),
    ]
    items = observability_rows_to_activity_items(rows)
    assert len(items) == 2
    assert items[0].type == "session"
    assert items[0].title == "Run started"
    assert items[1].title == "Run completed"
    assert items[1].description and "duration_ms" in items[1].description


def test_activity_type_filter_message() -> None:
    rows = [
        _row("llm", payload={"kind": "x"}),
        _row("tool", payload={"name": "n", "status": "ok"}),
    ]
    items = observability_rows_to_activity_items(rows, activity_type_filter="message")
    assert len(items) == 1
    assert items[0].type == "message"


def test_activity_type_filter_channel_empty() -> None:
    rows = [_row("llm", payload={"kind": "x"})]
    items = observability_rows_to_activity_items(rows, activity_type_filter="channel")
    assert items == []


def test_unknown_event_skipped() -> None:
    rows = [_row("custom_metric", payload={})]
    items = observability_rows_to_activity_items(rows)
    assert items == []


def test_error_like_event_name_maps_to_error() -> None:
    rows = [_row("tool_failed", payload={"reason": "x"})]
    items = observability_rows_to_activity_items(rows)
    assert len(items) == 1
    assert items[0].type == "error"


def test_stable_id_same_payload() -> None:
    r = _row("llm", payload={"kind": "c"})
    items_twice = observability_rows_to_activity_items([r, r])
    assert len(items_twice) == 2
    assert items_twice[0].id == items_twice[1].id
