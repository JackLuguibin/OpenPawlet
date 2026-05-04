"""Decode optional cron metadata prefix from persisted job ``payload.message``."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

_META_RE = re.compile(r"^<!--cron-meta:(\{.*?\})-->\r?\n?", re.DOTALL)


@dataclass(frozen=True)
class DecodedCronPayload:
    """JSON metadata object (possibly empty) and user-visible prompt body."""

    meta: dict[str, Any]
    prompt: str


def decode_cron_payload(raw: str | None) -> DecodedCronPayload:
    """Split ``<!--cron-meta:{...}-->`` prefix from the stored message string."""
    if not raw:
        return DecodedCronPayload({}, "")
    match = _META_RE.match(raw)
    if not match:
        return DecodedCronPayload({}, raw)
    body = raw[match.end() :]
    try:
        meta_obj = json.loads(match.group(1))
    except (TypeError, ValueError):
        return DecodedCronPayload({}, raw)
    if not isinstance(meta_obj, dict):
        return DecodedCronPayload({}, raw)
    return DecodedCronPayload(meta_obj, body)
