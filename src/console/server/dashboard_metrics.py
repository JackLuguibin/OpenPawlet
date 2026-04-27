"""Aggregate dashboard metrics from workspace session JSONL files."""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from console.server.bot_workspace import workspace_root
from console.server.json_utils import is_metadata_row, iter_jsonl_file
from console.server.models.status import TokenUsage
from console.server.models.usage import UsageHistoryItem
from console.server.nanobot_user_config import (
    read_default_model,
    read_default_timezone,
    resolve_config_path,
)
from nanobot.session.manager import SessionManager


def _today_in_config_tz(iana: str | None) -> date:
    """Calendar 'today' in the configured IANA zone, or OS local if unset/invalid."""
    if iana:
        try:
            from zoneinfo import ZoneInfo

            return datetime.now(ZoneInfo(iana)).date()
        except Exception:
            pass
    return datetime.now().astimezone().date()


def _message_local_date(msg: dict[str, Any], iana: str | None) -> date | None:
    ts = msg.get("timestamp")
    if not isinstance(ts, str):
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    if iana:
        try:
            from zoneinfo import ZoneInfo

            dt = dt.astimezone(ZoneInfo(iana))
        except Exception:
            dt = dt.astimezone()
    else:
        dt = dt.astimezone()
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


def _accumulate_token_usage_jsonl(
    workspace: Path,
    *,
    day_prompt: dict[date, int],
    day_completion: dict[date, int],
    day_by_model: dict[date, dict[str, dict[str, int]]],
    all_time_by_model: dict[str, dict[str, int]],
    default_model: str,
    today: date,
    start: date,
    iana_tz: str | None,
) -> None:
    """Merge LLM usage rows from ``usage/token_usage_*.jsonl`` (provider-level log)."""
    usage_dir = workspace / "usage"
    if not usage_dir.is_dir():
        return
    for path in sorted(usage_dir.glob("token_usage_*.jsonl")):
        for data in iter_jsonl_file(
            path,
            where=lambda r: r.get("_type") == "llm_token_usage",
        ):
            msg_date = _message_local_date(data, iana_tz)
            if msg_date is None:
                continue
            if msg_date > today:
                continue
            u = data.get("usage")
            if not isinstance(u, dict):
                continue
            prompt = int(u.get("prompt_tokens") or 0)
            completion = int(u.get("completion_tokens") or 0)
            if prompt == 0 and completion == 0:
                continue
            model = _model_for_message(data, default_model)
            b_all = all_time_by_model[model]
            b_all["prompt_tokens"] += prompt
            b_all["completion_tokens"] += completion
            if msg_date < start:
                continue
            day_prompt[msg_date] += prompt
            day_completion[msg_date] += completion
            bucket = day_by_model[msg_date][model]
            bucket["prompt_tokens"] += prompt
            bucket["completion_tokens"] += completion


def _iter_session_messages(session_dir: Path) -> Any:
    for path in sorted(session_dir.glob("*.jsonl")):
        yield from iter_jsonl_file(path, where=lambda r: not is_metadata_row(r))


@dataclass(frozen=True)
class DashboardMetrics:
    """Per-workspace aggregates for status and usage history endpoints.

    ``model_token_totals`` sums all dates found in session JSONL and provider ``usage/*.jsonl`` logs
    (not limited to the rolling ``history_days`` window).
    """

    active_sessions: int
    messages_today: int
    token_usage_today: TokenUsage | None
    model_token_totals: dict[str, dict[str, int | None]] | None
    history: list[UsageHistoryItem]


def _collect_dashboard_metrics_uncached(
    bot_id: str | None, *, history_days: int = 14
) -> DashboardMetrics:
    """Slow-path implementation; ``collect_dashboard_metrics`` adds TTL caching."""
    cfg_path = resolve_config_path(bot_id)
    default_model = read_default_model(cfg_path) or "unknown"
    iana_tz = read_default_timezone(cfg_path)

    mgr = SessionManager(workspace_root(bot_id), timezone=iana_tz)
    active_sessions = len(list(mgr.sessions_dir.glob("*.jsonl")))

    today = _today_in_config_tz(iana_tz)
    start = today - timedelta(days=max(1, history_days) - 1)

    day_prompt: dict[date, int] = defaultdict(int)
    day_completion: dict[date, int] = defaultdict(int)
    day_by_model: dict[date, dict[str, dict[str, int]]] = defaultdict(
        lambda: defaultdict(
            lambda: {"prompt_tokens": 0, "completion_tokens": 0},
        )
    )
    all_time_by_model: dict[str, dict[str, int]] = defaultdict(
        lambda: {"prompt_tokens": 0, "completion_tokens": 0},
    )

    messages_today = 0

    session_dir = mgr.sessions_dir
    for msg in _iter_session_messages(session_dir):
        role = msg.get("role")
        if role not in ("user", "assistant"):
            continue
        msg_date = _message_local_date(msg, iana_tz)
        if msg_date is None:
            continue
        if msg_date == today:
            messages_today += 1
        if msg_date > today:
            continue
        usage = _usage_pair(msg)
        if usage is None:
            continue
        prompt, completion = usage
        model = _model_for_message(msg, default_model)
        b_all = all_time_by_model[model]
        b_all["prompt_tokens"] += prompt
        b_all["completion_tokens"] += completion
        if msg_date < start:
            continue
        day_prompt[msg_date] += prompt
        day_completion[msg_date] += completion
        bucket = day_by_model[msg_date][model]
        bucket["prompt_tokens"] += prompt
        bucket["completion_tokens"] += completion

    _accumulate_token_usage_jsonl(
        mgr.workspace,
        day_prompt=day_prompt,
        day_completion=day_completion,
        day_by_model=day_by_model,
        all_time_by_model=all_time_by_model,
        default_model=default_model,
        today=today,
        start=start,
        iana_tz=iana_tz,
    )

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

    model_token_totals: dict[str, dict[str, int | None]] | None = None
    if all_time_by_model:
        model_token_totals = {}
        for model, parts in all_time_by_model.items():
            p = int(parts["prompt_tokens"])
            c = int(parts["completion_tokens"])
            if p == 0 and c == 0:
                continue
            model_token_totals[model] = {
                "prompt_tokens": p,
                "completion_tokens": c,
                "total_tokens": p + c,
            }
        if not model_token_totals:
            model_token_totals = None

    return DashboardMetrics(
        active_sessions=active_sessions,
        messages_today=messages_today,
        token_usage_today=token_usage_today,
        model_token_totals=model_token_totals,
        history=history,
    )


def collect_dashboard_metrics(bot_id: str | None, *, history_days: int = 14) -> DashboardMetrics:
    """Cached wrapper around :func:`_collect_dashboard_metrics_uncached`.

    ``/api/v1/status`` polls every few seconds; recomputing the same
    aggregate from disk on each call is wasteful and can hit O(n) IO on
    large session archives.  A 5 s TTL gives the dashboard near-realtime
    feel while collapsing back-to-back polls into a single scan.
    """
    from console.server.cache import dashboard_cache

    return dashboard_cache().get_or_load(
        ("dashboard_metrics", bot_id, history_days),
        lambda: _collect_dashboard_metrics_uncached(bot_id, history_days=history_days),
    )
