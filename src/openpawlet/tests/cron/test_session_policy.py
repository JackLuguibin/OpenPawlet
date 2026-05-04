"""Cron session routing policies (latest / fixed / fan-out)."""

from __future__ import annotations

from openpawlet.cron.session_policy import resolve_cron_run_targets
from openpawlet.utils.background_session import MAIN_AGENT_DREAM_SESSION_KEY


class _Sessions:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    def list_sessions(self):
        return list(self._rows)


def _dream():
    return [
        (
            MAIN_AGENT_DREAM_SESSION_KEY,
            "system",
            "dream",
        )
    ]


def test_default_uses_payload_session_key_or_dream():
    targets = resolve_cron_run_targets(
        message="plain",
        payload_session_key=None,
        payload_channel=None,
        payload_to=None,
        job_id="j1",
        session_manager=_Sessions([]),
    )
    assert targets == _dream()

    targets2 = resolve_cron_run_targets(
        message="plain",
        payload_session_key="slack:C123",
        payload_channel=None,
        payload_to=None,
        job_id="j2",
        session_manager=_Sessions([]),
    )
    assert targets2 == [("slack:C123", "slack", "C123")]


def test_fixed_reads_meta_fixed_session_key():
    msg = (
        '<!--cron-meta:{"sessionPolicy":"fixed","fixedSessionKey":"tg:777"}'
        '-->\ndo work'
    )
    targets = resolve_cron_run_targets(
        message=msg,
        payload_session_key=None,
        payload_channel="cli",
        payload_to="x",
        job_id="j3",
        session_manager=_Sessions([]),
    )
    assert targets == [("tg:777", "tg", "777")]


def test_latest_skips_background_keys():
    sm = _Sessions(
        [
            {"key": MAIN_AGENT_DREAM_SESSION_KEY, "updated_at": "2999"},
            {"key": "telegram:alice", "updated_at": "2000"},
        ]
    )
    msg = '<!--cron-meta:{"sessionPolicy":"latest"}-->\nhi'
    targets = resolve_cron_run_targets(
        message=msg,
        payload_session_key=None,
        payload_channel=None,
        payload_to=None,
        job_id="j4",
        session_manager=sm,
    )
    assert targets == [("telegram:alice", "telegram", "alice")]


def test_all_returns_all_eligible_in_order():
    sm = _Sessions(
        [
            {"key": "telegram:a", "updated_at": "3"},
            {"key": MAIN_AGENT_DREAM_SESSION_KEY},
            {"key": "slack:b", "updated_at": "2"},
        ]
    )
    msg = '<!--cron-meta:{"sessionPolicy":"all"}-->\nhi'
    targets = resolve_cron_run_targets(
        message=msg,
        payload_session_key=None,
        payload_channel=None,
        payload_to=None,
        job_id="j5",
        session_manager=sm,
    )
    assert targets == [
        ("telegram:a", "telegram", "a"),
        ("slack:b", "slack", "b"),
    ]


def test_new_generates_stable_prefix():
    msg = '<!--cron-meta:{"sessionPolicy":"new"}-->\nrun'
    t1 = resolve_cron_run_targets(
        message=msg,
        payload_session_key=None,
        payload_channel=None,
        payload_to=None,
        job_id="abc123",
        session_manager=_Sessions([]),
    )
    assert len(t1) == 1
    sk, ch, cid = t1[0]
    assert sk.startswith("cron:abc123-")
    assert ch == "cron"
    assert sk.split(":", 1)[1] == cid
