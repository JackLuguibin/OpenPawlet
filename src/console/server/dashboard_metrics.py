"""Aggregate dashboard metrics from workspace session JSONL files."""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from nanobot.session.manager import SessionManager

from console.server.bot_workspace import workspace_root
from console.server.models.status import TokenUsage
from console.server.models.usage import UsageHistoryItem
from console.server.nanobot_user_config import (
    read_default_model,
    resolve_config_path,
)


def _message_local_date(msg: dict[str, Any]) -> date | None:
    ts = msg.get("timestamp")
    if not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", ""))
    except ValueError:
        return None
    return dt.date()


def _usage_pair(msg: dict[str, Any]) -> tuple[int, int] | None:
    u = msg.get("usage")
    if not isinstance(u, dict):
        return None
    prompt = int(u.get("prompt_tokens") or 0)
    completion = int(u.get("completion_tokens") or 0)
    return prompt, completion


def _model_for_message(msg: dict[str, Any], default_model: str) -> str:
    model = msg.get("model")
    if isinstance(model, str) and model.strip():
        return model.strip()
    return default_model


def _iter_session_messages(session_dir: Path) -> Any:
    for path in sorted(session_dir.glob("*.jsonl")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                data = json.loads(line)
            except json.JSONDecodeError:
                continue
            if data.get("_type") == "metadata":
                continue
            if isinstance(data, dict):
                yield data


@dataclass(frozen=True)
class DashboardMetrics:
    """Per-workspace aggregates for status and usage history endpoints."""

    active_sessions: int
    messages_today: int
    token_usage_today: TokenUsage | None
    history: list[UsageHistoryItem]


def collect_dashboard_metrics(
    bot_id: str | None, *, history_days: int = 14
) -> DashboardMetrics:
    """Scan session files for session counts, today's stats, and daily token history."""
    cfg_path = resolve_config_path(bot_id)
    default_model = read_default_model(cfg_path) or "unknown"

    mgr = SessionManager(workspace_root(bot_id))
    active_sessions = len(list(mgr.sessions_dir.glob("*.jsonl")))

    today = date.today()
    start = today - timedelta(days=max(1, history_days) - 1)

    day_prompt: dict[date, int] = defaultdict(int)
    day_completion: dict[date, int] = defaultdict(int)
    day_by_model: dict[date, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(
            lambda: {"prompt_tokens": 0, "completion_tokens": 0},
        )
    )

    messages_today = 0

    session_dir = mgr.sessions_dir
    for msg in _iter_session_messages(session_dir):
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        msg_date = _message_local_date(msg)
        if msg_date is None:
            continue
        if msg_date == today:
            messages_today += 1
        if msg_date < start or msg_date > today:
            continue
        usage = _usage_pair(msg)
        if usage is None:
            continue
        prompt, completion = usage
        model = _model_for_message(msg, default_model)
        day_prompt[msg_date] += prompt
        day_completion[msg_date] += completion
        bucket = day_by_model[msg_date][model]
        bucket["prompt_tokens"] += prompt
        bucket["completion_tokens"] += completion

    token_usage_today: TokenUsage | None = None
    pt_today = day_prompt.get(today, 0)
    ct_today = day_completion.get(today, 0)
    if pt_today > 0 or ct_today > 0:
        by_model_today: dict[str, dict[str, int | None]] = {}
        for model, parts in day_by_model[today].items():
            p = int(parts["prompt_tokens"])
            c = int(parts["completion_tokens"])
            by_model_today[model] = {
                "prompt_tokens": p,
                "completion_tokens": c,
                "total_tokens": p + c,
            }
        token_usage_today = TokenUsage(
            prompt_tokens=pt_today,
            completion_tokens=ct_today,
            total_tokens=pt_today + ct_today,
            by_model=by_model_today,
            cost_usd=None,
            cost_by_model=None,
        )

    history: list[UsageHistoryItem] = []
    cursor = start
    while cursor <= today:
        p = day_prompt.get(cursor, 0)
        c = day_completion.get(cursor, 0)
        by_model_day: dict[str, dict[str, int | None]] | None = None
        if cursor in day_by_model and day_by_model[cursor]:
            by_model_day = {}
            for model, parts in day_by_model[cursor].items():
                pi = int(parts["prompt_tokens"])
                ci = int(parts["completion_tokens"])
                by_model_day[model] = {
                    "prompt_tokens": pi,
                    "completion_tokens": ci,
                    "total_tokens": pi + ci,
                }
        history.append(
            UsageHistoryItem(
                date=cursor.isoformat(),
                total_tokens=p + c,
                prompt_tokens=p,
                completion_tokens=c,
                by_model=by_model_day,
                cost_usd=None,
                cost_by_model=None,
            )
        )
        cursor += timedelta(days=1)

    return DashboardMetrics(
        active_sessions=active_sessions,
        messages_today=messages_today,
        token_usage_today=token_usage_today,
        history=history,
    )
