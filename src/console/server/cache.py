"""Lightweight in-memory caches used by the console server.

The console resolves the same nanobot ``config.json`` on every API
request (``workspace_root``, ``read_default_model``,
``read_default_timezone``, ``build_config_response``, ...).  At idle the
overhead is small but a 5 s polling SPA hits ``/api/v1/status`` 12
times a minute, each of which re-validates the entire ``Config``
schema and re-reads the file from disk - cumulatively material on slow
filesystems.

The helpers here cache by ``(path, mtime_ns)`` so file edits invalidate
naturally; we do not need an explicit invalidate API.  Callers fall
back to the slow path when the file is missing (``mtime_ns`` cannot be
read), so the cache never serves stale data after a delete.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from pathlib import Path
from typing import Any, TypeVar

T = TypeVar("T")


class MtimeCache:
    """Cache values keyed by ``(path, loader_id, mtime_ns)``.

    ``get_or_load`` calls *loader* only when the file mtime has changed
    since the last call.  Entries are partitioned by *loader* identity
    so two callers (e.g. one returning a ``Config`` dict, another
    returning a ``Path``) for the same file never collide.

    Entries are kept indefinitely; cache size is bounded by
    ``len(distinct paths) * len(distinct loaders)`` in practice.
    """

    def __init__(self) -> None:
        self._values: dict[tuple[Path, int], tuple[int, Any]] = {}

    @staticmethod
    def _loader_key(loader: Callable[[Path], Any]) -> int:
        # ``id()`` is stable for the lifetime of the loader function, which
        # is module-level in every current call site.  This avoids pickling
        # closures or relying on qualified names that could collide.
        return id(loader)

    def get_or_load(self, path: Path, loader: Callable[[Path], T]) -> T:
        cache_key = (path, self._loader_key(loader))
        try:
            mtime_ns = path.stat().st_mtime_ns
        except FileNotFoundError:
            # No file means we cannot trust any prior cache entry; force
            # the loader to handle the "missing" case itself.
            self._values.pop(cache_key, None)
            return loader(path)
        entry = self._values.get(cache_key)
        if entry is not None and entry[0] == mtime_ns:
            return entry[1]  # type: ignore[no-any-return]
        value = loader(path)
        self._values[cache_key] = (mtime_ns, value)
        return value

    def invalidate(self, path: Path | None = None) -> None:
        if path is None:
            self._values.clear()
            return
        for key in [k for k in self._values if k[0] == path]:
            self._values.pop(key, None)


class TtlCache:
    """Tiny TTL cache for derived metrics.

    Cheaper than depending on cachetools and good enough for the small
    set of dashboard / status responses we want to memoize.  Values are
    keyed by an arbitrary hashable; missing or expired entries trigger
    *loader*.
    """

    def __init__(self, ttl_s: float) -> None:
        self._ttl_s = ttl_s
        self._values: dict[Any, tuple[float, Any]] = {}

    def get_or_load(self, key: Any, loader: Callable[[], T]) -> T:
        now = time.monotonic()
        entry = self._values.get(key)
        if entry is not None and (now - entry[0]) < self._ttl_s:
            return entry[1]  # type: ignore[no-any-return]
        value = loader()
        self._values[key] = (now, value)
        return value

    def invalidate(self, key: Any | None = None) -> None:
        if key is None:
            self._values.clear()
        else:
            self._values.pop(key, None)


# Process-wide singletons - the console runs as a single uvicorn worker
# in the unified layout, so a module-level cache is safe.
_CONFIG_CACHE = MtimeCache()
_DASHBOARD_CACHE = TtlCache(ttl_s=5.0)


def config_cache() -> MtimeCache:
    return _CONFIG_CACHE


def dashboard_cache() -> TtlCache:
    return _DASHBOARD_CACHE


__all__ = [
    "MtimeCache",
    "TtlCache",
    "config_cache",
    "dashboard_cache",
]
