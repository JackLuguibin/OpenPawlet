"""Structured agent tracing: trace_id correlation, log/buffer/JSONL events, span nesting depth."""

from __future__ import annotations

import os
import time
import uuid
from collections.abc import Iterator
from contextlib import asynccontextmanager, contextmanager
from contextvars import ContextVar
from typing import Any

from loguru import logger

from nanobot.observability.buffer import is_buffer_enabled, is_jsonl_enabled, record_event

_TRACE_ID: ContextVar[str | None] = ContextVar("nb_trace_id", default=None)
_SESSION_KEY: ContextVar[str | None] = ContextVar("nb_session_key", default=None)
_SPAN_DEPTH: ContextVar[int] = ContextVar("nb_span_depth", default=0)


def is_observability_logging_enabled() -> bool:
    """When False, trace_id is still set; ``obs |`` log lines are skipped."""
    v = (os.environ.get("NANOBOT_OBS_LOG") or "1").strip().lower()
    return v not in ("0", "false", "no", "off")


def get_trace_id() -> str | None:
    return _TRACE_ID.get()


def get_session_key() -> str | None:
    return _SESSION_KEY.get()


@asynccontextmanager
async def agent_run_context(session_key: str | None):
    """Per ``AgentRunner.run`` root: new trace_id for log / trace correlation."""
    trace_id = str(uuid.uuid4())
    tok_trace = _TRACE_ID.set(trace_id)
    tok_sess = _SESSION_KEY.set(session_key)
    tok_depth = _SPAN_DEPTH.set(0)
    t0 = time.perf_counter()
    if is_buffer_enabled() or is_jsonl_enabled():
        record_event(
            "run_start",
            trace_id=trace_id,
            session_key=session_key,
            payload={},
        )
    if is_observability_logging_enabled():
        logger.info(
            "obs | event=run_start | trace_id={} | session_key={!r}",
            trace_id,
            session_key,
        )
    try:
        yield trace_id
    finally:
        dt = (time.perf_counter() - t0) * 1000.0
        if is_buffer_enabled() or is_jsonl_enabled():
            record_event(
                "run_end",
                trace_id=trace_id,
                session_key=session_key,
                payload={"duration_ms": round(dt, 3)},
            )
        if is_observability_logging_enabled():
            logger.info(
                "obs | event=run_end | trace_id={} | session_key={!r} | duration_ms={:.2f}",
                trace_id,
                session_key,
                dt,
            )
        _SPAN_DEPTH.reset(tok_depth)
        _SESSION_KEY.reset(tok_sess)
        _TRACE_ID.reset(tok_trace)


@contextmanager
def _depth_span() -> Iterator[None]:
    d = _SPAN_DEPTH.get() + 1
    t = _SPAN_DEPTH.set(d)
    try:
        yield
    finally:
        _SPAN_DEPTH.reset(t)


@contextmanager
def llm_request_span(
    *,
    kind: str,
    model: str | None,
    iteration: int,
    streaming: bool,
) -> Iterator[None]:
    """Wrap a single provider chat / stream call (sync ``with`` around ``await`` is OK in async code)."""
    _ = (kind, model, iteration, streaming)  # call-site / future use; depth nesting only
    with _depth_span():
        yield


def log_llm_response(
    *,
    kind: str,
    model: str | None,
    iteration: int,
    wall_ms: float,
    response_summary: dict[str, Any],
) -> None:
    """Model outcome, wall-clock duration, and token usage. Filter with ``grep 'obs | event=llm'``."""
    trace_id = get_trace_id()
    session_key = get_session_key()
    if is_buffer_enabled() or is_jsonl_enabled():
        record_event(
            "llm",
            trace_id=trace_id,
            session_key=session_key,
            payload={
                "kind": kind,
                "model": model,
                "iteration": iteration,
                "wall_ms": round(wall_ms, 3),
                "summary": response_summary,
            },
        )
    if not is_observability_logging_enabled():
        return
    try:
        payload = str(response_summary)[:2000]
    except Exception:  # noqa: BLE001
        payload = "<unprintable>"
    logger.info(
        "obs | event=llm | trace_id={} | kind={!r} | model={!r} | iteration={} | wall_ms={:.2f} | {}",
        trace_id,
        kind,
        model,
        iteration,
        wall_ms,
        payload,
    )


@contextmanager
def tool_execution_span(
    *,
    name: str,
    tool_call_id: str,
    iteration: int,
) -> Iterator[None]:
    """Track span nesting depth around a tool call (see ``_SPAN_DEPTH``)."""
    _ = (name, tool_call_id, iteration)
    with _depth_span():
        yield


def log_tool_outcome(
    *,
    name: str,
    tool_call_id: str,
    iteration: int,
    status: str,
    detail: str | None,
    duration_ms: float,
) -> None:
    trace_id = get_trace_id()
    session_key = get_session_key()
    if is_buffer_enabled() or is_jsonl_enabled():
        pl: dict[str, Any] = {
            "name": name,
            "tool_call_id": tool_call_id,
            "iteration": iteration,
            "duration_ms": round(duration_ms, 3),
            "status": status,
        }
        if detail is not None:
            pl["detail"] = detail
        record_event("tool", trace_id=trace_id, session_key=session_key, payload=pl)
    if not is_observability_logging_enabled():
        return
    tail = f" | detail={detail!r}" if detail else ""
    logger.info(
        "obs | event=tool | trace_id={} | name={!r} | tool_call_id={!r} | iteration={} | "
        "duration_ms={:.2f} | status={}{}",
        trace_id,
        name,
        tool_call_id,
        iteration,
        duration_ms,
        status,
        tail,
    )
