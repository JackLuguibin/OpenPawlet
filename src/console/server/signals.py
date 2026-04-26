"""Cross-platform helpers for asyncio event loop policy and signal handling.

Centralizes the small platform-specific quirks the console needs so each
entrypoint just has to call into this module instead of duplicating
``sys.platform`` checks.
"""

from __future__ import annotations

import asyncio
import signal
import sys
from collections.abc import Callable

__all__ = [
    "configure_windows_event_loop_policy",
    "install_async_signal_handlers",
    "install_signal_handlers",
]


def configure_windows_event_loop_policy() -> None:
    """Force the selector event-loop policy on Windows.

    The default proactor loop on Windows breaks third-party libraries
    that assume a selector loop, and is also incompatible with
    ``loop.add_signal_handler``.  Calling this helper before the first
    ``asyncio.run`` keeps behaviour aligned with Linux/macOS.
    """
    if not sys.platform.startswith("win"):
        return
    policy = asyncio.get_event_loop_policy()
    if isinstance(policy, asyncio.WindowsSelectorEventLoopPolicy):
        return
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())


def install_async_signal_handlers(
    loop: asyncio.AbstractEventLoop,
    on_stop: Callable[[], None],
    *,
    signals: tuple[int, ...] | None = None,
) -> None:
    """Wire ``SIGINT``/``SIGTERM`` (and friends) to *on_stop* on *loop*.

    Uses :meth:`asyncio.AbstractEventLoop.add_signal_handler` on Linux/macOS
    and falls back to plain :func:`signal.signal` on Windows where the
    asyncio API raises ``NotImplementedError``.  *on_stop* is invoked
    synchronously - keep it cheap (typically ``stop_event.set()``).
    """
    if signals is None:
        signals = (signal.SIGINT,) + ((signal.SIGTERM,) if hasattr(signal, "SIGTERM") else ())

    def _proxy(*_: object) -> None:
        on_stop()

    for sig in signals:
        try:
            loop.add_signal_handler(sig, on_stop)
        except (NotImplementedError, RuntimeError):
            # Windows: fall back to signal.signal which still delivers
            # SIGINT (Ctrl+C) and SIGTERM via the C runtime.
            try:
                signal.signal(sig, _proxy)
            except (ValueError, OSError):  # pragma: no cover - signal not available
                continue


def install_signal_handlers(
    on_stop: Callable[[], None],
    *,
    signals: tuple[int, ...] | None = None,
) -> tuple[tuple[int, object], ...]:
    """Synchronous variant for code paths that do not own an event loop.

    Returns the previously installed handlers so callers can restore
    them in ``finally`` blocks.  Falls back gracefully when a signal is
    not available on the host platform (e.g. ``SIGTERM`` on some Windows
    setups, or ``SIGHUP`` always missing on Windows).
    """
    if signals is None:
        signals = (signal.SIGINT,) + ((signal.SIGTERM,) if hasattr(signal, "SIGTERM") else ())

    def _proxy(_signum: int, _frame: object) -> None:
        on_stop()

    previous: list[tuple[int, object]] = []
    for sig in signals:
        try:
            previous.append((sig, signal.getsignal(sig)))
            signal.signal(sig, _proxy)
        except (ValueError, OSError):  # pragma: no cover
            continue
    return tuple(previous)
