"""Shared JSON / JSONL helpers used across the console server.

Centralizes the small set of file IO primitives that several modules
re-implemented (atomic write with Windows-friendly retry, tolerant JSONL
parsing, etc.) so call sites stay short and behaviour stays consistent.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from fastapi import HTTPException
from loguru import logger


def read_utf8_file(path: Path) -> str | None:
    """Return UTF-8 text of *path* or ``None`` when the file does not exist.

    OS-level errors (other than the missing-file case caught by ``is_file``)
    propagate so the caller can decide how to surface them.
    """
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError as exc:
        logger.warning("[json_utils] read failed {}: {}", path, exc)
        return None


def load_json_file(path: Path, default: Any) -> Any:
    """Load JSON from *path* or return *default* on missing / invalid content."""
    if not path.is_file():
        return default
    try:
        with path.open(encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as exc:
        logger.warning("[json_utils] bad JSON {}: {}", path, exc)
        return default


def save_json_file(path: Path, data: Any, *, indent: int = 2) -> None:
    """Atomically write JSON, retrying ``replace`` on transient Windows errors.

    On Windows ``tmp.replace(path)`` can briefly raise ``PermissionError``
    when antivirus / search indexer holds the destination open.  A short
    exponential backoff makes the operation robust without surfacing a 500
    to the caller.

    Raises:
        HTTPException: ``500`` when the file cannot be written or replaced.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as f:
            json.dump(data, f, indent=indent, ensure_ascii=False)
    except OSError as exc:
        logger.warning("[json_utils] write failed {}: {}", path, exc)
        raise HTTPException(status_code=500, detail="Failed to save state") from exc

    last_exc: OSError | None = None
    for attempt in range(3):
        try:
            tmp.replace(path)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.05 * (2**attempt))
        except OSError as exc:
            logger.warning("[json_utils] replace failed {}: {}", path, exc)
            raise HTTPException(status_code=500, detail="Failed to save state") from exc

    logger.warning("[json_utils] replace exhausted retries {}: {}", path, last_exc)
    raise HTTPException(status_code=500, detail="Failed to save state") from last_exc


def iter_jsonl_dicts(
    text: str,
    *,
    where: Callable[[dict[str, Any]], bool] | None = None,
) -> Iterator[dict[str, Any]]:
    """Iterate over JSONL *text*, yielding dict rows that satisfy *where*.

    Empty lines, non-JSON lines, and rows that are not ``dict`` are silently
    skipped so partial writes never break the consumer.
    """
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            data = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(data, dict):
            continue
        if where is not None and not where(data):
            continue
        yield data


def iter_jsonl_file(
    path: Path,
    *,
    where: Callable[[dict[str, Any]], bool] | None = None,
) -> Iterator[dict[str, Any]]:
    """Yield dict rows from a JSONL file, applying optional *where* filter."""
    text = read_utf8_file(path)
    if text is None:
        return
    yield from iter_jsonl_dicts(text, where=where)


def is_metadata_row(row: dict[str, Any]) -> bool:
    """Return True for the leading ``{"_type": "metadata"}`` row in a JSONL file."""
    return row.get("_type") == "metadata"


def is_event_row(row: dict[str, Any]) -> bool:
    """Return True for compaction/eviction event rows (``{"_event": ...}``)."""
    return bool(row.get("_event"))


__all__ = [
    "read_utf8_file",
    "load_json_file",
    "save_json_file",
    "iter_jsonl_dicts",
    "iter_jsonl_file",
    "is_metadata_row",
    "is_event_row",
]
