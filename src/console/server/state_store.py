"""Atomic JSON state read-modify-write helpers.

The console persists a number of small JSON state files
(``agents.json``, ``teams.json``, ``runtime_state.json``, ...) under
``<workspace>/.nanobot_console/``.  Mutations are issued from concurrent
HTTP handlers, which used to follow an unlocked
``load_json_file -> mutate -> save_json_file`` pattern that is racy in
two ways:

* Two coroutines on the same event loop can interleave their mutations
  and lose updates (last-writer wins).
* On a multi-worker deployment, two processes can race the
  ``tmp.replace(path)`` step and overwrite each other.

This module packages the load + lock + save flow behind a single
``json_state(path)`` async context manager so routers can do the
common case in one block.  It uses :class:`filelock.FileLock` for the
cross-process guarantee and an in-process ``asyncio.Lock`` per path so
multiple coroutines inside the same worker also serialise.
"""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from filelock import FileLock, Timeout
from loguru import logger

# Per-path asyncio locks so coroutines inside the same worker process
# never race each other before they even hit the filesystem lock.
_PATH_LOCKS: dict[str, asyncio.Lock] = {}
_PATH_LOCKS_GUARD = asyncio.Lock()

# Default for blocking acquisition of FileLock.  Long enough for normal
# contention, short enough to surface deadlocks in tests.
_DEFAULT_FILELOCK_TIMEOUT_S = 5.0
# Number of times ``tmp.replace(path)`` is retried on Windows when another
# handle still holds the destination open.
_REPLACE_RETRIES = 3


def _lock_path_for(path: Path) -> Path:
    """Return the sidecar lock file path for *path* (``<path>.lock``)."""
    return path.with_suffix(path.suffix + ".lock")


async def _get_async_lock(path: Path) -> asyncio.Lock:
    """Return the per-path :class:`asyncio.Lock`, creating it lazily."""
    key = str(path.resolve()) if path.exists() else str(path.absolute())
    async with _PATH_LOCKS_GUARD:
        lock = _PATH_LOCKS.get(key)
        if lock is None:
            lock = asyncio.Lock()
            _PATH_LOCKS[key] = lock
        return lock


def _atomic_write_with_retry(path: Path, payload: str) -> None:
    """Write *payload* atomically; retry replace on Windows handle races.

    On Windows, ``Path.replace`` raises ``PermissionError`` when the
    destination is briefly opened by an antivirus / search indexer; we
    back off and retry rather than surfacing a 500 to the caller.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    last_exc: OSError | None = None
    for attempt in range(_REPLACE_RETRIES):
        try:
            tmp.replace(path)
            return
        except PermissionError as exc:
            last_exc = exc
            time.sleep(0.05 * (2**attempt))
    # Final attempt; let the caller see the error if it still fails.
    if last_exc is not None:
        logger.warning("[state_store] retried tmp.replace failed for {}", path)
    tmp.replace(path)


@asynccontextmanager
async def json_state(
    path: Path,
    *,
    default: Any = None,
    timeout_s: float = _DEFAULT_FILELOCK_TIMEOUT_S,
) -> AsyncIterator[dict[str, Any]]:
    """Async context yielding a dict snapshot of *path*; auto-writes on exit.

    Usage::

        async with json_state(path, default={}) as data:
            data["foo"] = "bar"

    The file is locked across the whole block (both filesystem and
    asyncio).  Exiting normally serialises ``data`` back to disk
    atomically; exiting via exception leaves the file untouched so
    partial state never lands on disk.

    ``default`` is used when *path* is missing or contains invalid JSON.
    The yielded value is always a ``dict`` even if the on-disk root was
    something else (the original is replaced when the block writes back).
    """
    async_lock = await _get_async_lock(path)
    file_lock = FileLock(str(_lock_path_for(path)))

    async with async_lock:
        try:
            file_lock.acquire(timeout=timeout_s)
        except Timeout as exc:
            raise TimeoutError(
                f"timed out acquiring state lock for {path}"
            ) from exc
        try:
            data: dict[str, Any]
            if path.exists():
                try:
                    raw = json.loads(path.read_text(encoding="utf-8"))
                    data = raw if isinstance(raw, dict) else dict(default or {})
                except (OSError, json.JSONDecodeError) as exc:
                    logger.warning("[state_store] bad JSON {}: {}", path, exc)
                    data = dict(default or {})
            else:
                data = dict(default or {})

            yield data

            payload = json.dumps(data, indent=2, ensure_ascii=False)
            _atomic_write_with_retry(path, payload)
        finally:
            file_lock.release()


__all__ = ["json_state"]
