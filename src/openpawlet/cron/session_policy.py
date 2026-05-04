"""Resolve which session(s) a cron job run should execute in."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from loguru import logger

from openpawlet.cron.message_decode import decode_cron_payload
from openpawlet.utils.background_session import MAIN_AGENT_DREAM_SESSION_KEY

if TYPE_CHECKING:
    from openpawlet.session.manager import SessionManager

_CRON_FANOUT_SKIP_PREFIXES = ("temp",)
"""Skip session keys whose channel part is ``temp`` (legacy ``temp:*`` routing)."""


def session_key_channel_chat(
    session_key: str,
    *,
    fallback_channel: str,
    fallback_chat_id: str,
) -> tuple[str, str]:
    """Derive routing channel/chat_id from a ``channel:chat`` session key."""
    sk = session_key.strip()
    if ":" in sk:
        ch, cid = sk.split(":", 1)
        ch_st, cid_st = ch.strip(), cid.strip()
        if ch_st and cid_st:
            return ch_st, cid_st
    fb_ch = fallback_channel.strip() or "cli"
    fb_cid = fallback_chat_id.strip() or "direct"
    return fb_ch, fb_cid


def _should_skip_fanout_candidate(key: str) -> bool:
    k = (key or "").strip()
    if not k:
        return True
    if k == MAIN_AGENT_DREAM_SESSION_KEY or k == "heartbeat":
        return True
    if ":" not in k:
        return False
    channel_prefix, _ = k.split(":", 1)
    channel_prefix = channel_prefix.strip().lower()
    if channel_prefix in _CRON_FANOUT_SKIP_PREFIXES:
        return True
    if channel_prefix == "cron":
        return True
    return False


def resolve_cron_run_targets(
    *,
    message: str | None,
    payload_session_key: str | None,
    payload_channel: str | None,
    payload_to: str | None,
    job_id: str,
    session_manager: SessionManager | Any | None,
) -> list[tuple[str, str, str]]:
    """Return `(session_key, channel, chat_id)` entries for each agent turn."""
    meta = decode_cron_payload(message or "").meta

    raw_policy = meta.get("sessionPolicy")
    policy = str(raw_policy).strip().lower() if raw_policy else "default"

    fb_ch = (
        payload_channel.strip()
        if isinstance(payload_channel, str) and payload_channel.strip()
        else "cli"
    )
    fb_cid = (
        payload_to.strip() if isinstance(payload_to, str) and payload_to.strip() else "direct"
    )

    sess_from_payload = (
        payload_session_key.strip()
        if isinstance(payload_session_key, str) and payload_session_key.strip()
        else ""
    )

    def _dream_fallback() -> list[tuple[str, str, str]]:
        sk = sess_from_payload or MAIN_AGENT_DREAM_SESSION_KEY
        ch, cid = session_key_channel_chat(
            sk, fallback_channel=fb_ch, fallback_chat_id=fb_cid
        )
        return [(sk, ch, cid)]

    if policy in ("", "default", "inherit"):
        return _dream_fallback()

    if policy == "fixed":
        fixed_raw = meta.get("fixedSessionKey")
        fk = (
            fixed_raw.strip()
            if isinstance(fixed_raw, str) and fixed_raw.strip()
            else sess_from_payload
        )
        if not fk:
            logger.warning(
                "cron job {!r} uses sessionPolicy=fixed but fixedSessionKey / session_key is empty; "
                "falling back to default session",
                job_id,
            )
            return _dream_fallback()
        ch, cid = session_key_channel_chat(
            fk, fallback_channel=fb_ch, fallback_chat_id=fb_cid
        )
        return [(fk, ch, cid)]

    if policy == "new":
        run_sk = f"cron:{job_id}-{uuid.uuid4().hex[:10]}"
        ch, cid = session_key_channel_chat(
            run_sk, fallback_channel=fb_ch, fallback_chat_id=fb_cid
        )
        return [(run_sk, ch, cid)]

    if policy in ("latest", "all"):
        if session_manager is None:
            logger.warning(
                "cron job {!r} sessionPolicy={!r} but no session_manager; using default session",
                job_id,
                policy,
            )
            return _dream_fallback()

        infos = session_manager.list_sessions()
        eligible: list[str] = []
        seen: set[str] = set()
        for row in infos:
            key_val = row.get("key") if isinstance(row, dict) else None
            if not isinstance(key_val, str):
                continue
            k = key_val.strip()
            if not k or k in seen:
                continue
            if _should_skip_fanout_candidate(k):
                continue
            seen.add(k)
            eligible.append(k)

        if policy == "latest":
            if not eligible:
                logger.info(
                    "cron job {!r} sessionPolicy=latest found no eligible sessions; using default",
                    job_id,
                )
                return _dream_fallback()
            only = eligible[0]
            ch, cid = session_key_channel_chat(
                only, fallback_channel=fb_ch, fallback_chat_id=fb_cid
            )
            return [(only, ch, cid)]

        if not eligible:
            logger.info(
                "cron job {!r} sessionPolicy=all found no eligible sessions; using default",
                job_id,
            )
            return _dream_fallback()

        out: list[tuple[str, str, str]] = []
        for ek in eligible:
            ch, cid = session_key_channel_chat(
                ek, fallback_channel=fb_ch, fallback_chat_id=fb_cid
            )
            out.append((ek, ch, cid))
        return out

    logger.warning(
        "cron job {!r} has unknown sessionPolicy={!r}; using default session",
        job_id,
        policy,
    )
    return _dream_fallback()
