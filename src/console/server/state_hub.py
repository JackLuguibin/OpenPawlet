"""In-process pub/sub hub for pushing console state changes over WebSocket.

This module replaces the historical client-side polling pattern (``GET
/api/v1/status`` from Dashboard/Settings/Agents/Chat, the 4s ``runtime-agents``
refresh, the 1.5s transcript ``invalidateQueries`` timer, etc.) with a single
**server-driven** push channel.

Design goals:
    * One process-global singleton :class:`StateHub` so every place that
      mutates persistent state can broadcast a change without having to
      reach into the FastAPI ``app.state`` graph.
    * Per-bot subscriptions: a frame published with ``bot_id="X"`` is only
      delivered to clients that subscribed to bot ``X`` (or to the
      ``"*"`` wildcard for global frames such as ``bots_update``).
    * Backpressure tolerant: each subscriber owns an :class:`asyncio.Queue`
      with a bounded size; if a slow client cannot keep up we drop the
      oldest pending frame instead of blocking the publisher (state pushes
      are deltas — losing one is recoverable on the next event because the
      WS handler always sends a fresh snapshot on (re)subscribe).
    * Thread/loop safe publish: ``publish()`` schedules the actual
      enqueue onto the hub's owning event loop via
      :meth:`asyncio.AbstractEventLoop.call_soon_threadsafe` so synchronous
      writers (``set_bot_running`` is called from request handlers but the
      nanobot agent loop also writes session JSONL from a worker thread)
      do not need to be ``async def``-aware.

The frame shapes intentionally mirror the existing
``WSMessage`` contract on the SPA (``api/types.ts``); the hook
``hooks/useWebSocket.ts`` already routes ``status_update`` /
``sessions_update`` / ``activity_update`` / ``bots_update`` into React
Query and zustand caches, so adding the WS endpoint here is enough to
turn those legacy frames into the primary delivery mechanism.
"""

from __future__ import annotations

import asyncio
import contextlib
import time
from collections.abc import Mapping
from typing import Any
from uuid import uuid4

from loguru import logger

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Queue bound per subscriber.  Practical state-push rates are well below
# 10 frames/s; 64 leaves plenty of headroom for short bursts (e.g. a
# config save that fans out to status+channels+mcp at once) without
# letting a stalled client hold unbounded memory.
_QUEUE_MAXSIZE = 64

# Wildcard subscription token: subscribers that pass ``bot_id="*"`` (or
# ``None``) receive every published frame regardless of which bot it
# targets.  Used for global frames like ``bots_update``.
_WILDCARD = "*"

# How long the WS endpoint waits between server-side keepalive pings.
# Conservative enough to survive most idle-proxy cutoffs (~30-60s).
SERVER_PING_INTERVAL_S = 25.0


# ---------------------------------------------------------------------------
# Subscriber bookkeeping
# ---------------------------------------------------------------------------


class _Subscriber:
    """A single connected client.

    The handler owns ``queue`` and is the only consumer; the hub is the
    only producer.  ``bot_id`` may be reassigned at runtime when the
    client sends ``{"type": "subscribe", "bot_id": "..."}`` after the
    initial handshake (e.g. the SPA switches active bot without
    reconnecting).
    """

    __slots__ = ("id", "queue", "bot_id")

    def __init__(self, sub_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
        self.id = sub_id
        self.queue = queue
        # Until the client subscribes explicitly, deliver only wildcard
        # frames.  This avoids leaking a bot's status to a freshly opened
        # tab that has not yet declared which bot it is interested in.
        self.bot_id: str = _WILDCARD


# ---------------------------------------------------------------------------
# StateHub
# ---------------------------------------------------------------------------


class StateHub:
    """Process-global event bus for the console WebSocket push channel.

    Lifecycle:
        * Constructed on FastAPI startup via :func:`get_state_hub` (which
          binds it to the running event loop).
        * The WS endpoint registers each connection via
          :meth:`register_subscriber` and removes it on disconnect via
          :meth:`unregister_subscriber`.
        * Producers anywhere in the process call :meth:`publish`.

    The hub is intentionally *not* a singleton at module import time so
    tests can build a fresh instance per case and so the loop binding
    happens lazily on the first request (avoiding the "no running event
    loop" error when modules are imported during sync test setup).
    """

    def __init__(self) -> None:
        self._loop: asyncio.AbstractEventLoop | None = None
        # Plain dict; ``unregister_subscriber`` is mandatory in the WS
        # handler's ``finally`` block so leaked entries should not
        # happen.  We keep a lock so concurrent register/unregister from
        # different connections cannot trample each other.
        self._subs: dict[str, _Subscriber] = {}
        self._lock = asyncio.Lock()

    # -- loop binding ----------------------------------------------------

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        """Pin the hub to *loop*.  Idempotent for the same loop."""
        if self._loop is loop:
            return
        if self._loop is not None and not self._loop.is_closed():
            logger.warning(
                "[state-hub] rebinding loop while previous loop still alive; "
                "this should only happen in tests"
            )
        self._loop = loop

    @property
    def loop(self) -> asyncio.AbstractEventLoop | None:
        return self._loop

    # -- subscription ----------------------------------------------------

    async def register_subscriber(
        self,
        bot_id: str | None = None,
    ) -> _Subscriber:
        """Allocate a queue + identifier for a new WS connection."""
        sub = _Subscriber(
            sub_id=uuid4().hex,
            queue=asyncio.Queue(maxsize=_QUEUE_MAXSIZE),
        )
        if bot_id:
            sub.bot_id = bot_id
        async with self._lock:
            self._subs[sub.id] = sub
        logger.debug(
            "[state-hub] subscriber {} registered (bot_id={})", sub.id, sub.bot_id
        )
        return sub

    async def unregister_subscriber(self, sub: _Subscriber) -> None:
        async with self._lock:
            self._subs.pop(sub.id, None)
        logger.debug("[state-hub] subscriber {} removed", sub.id)

    async def update_subscription(
        self,
        sub: _Subscriber,
        bot_id: str | None,
    ) -> None:
        """Re-target *sub* to a different bot scope."""
        sub.bot_id = bot_id or _WILDCARD
        logger.debug(
            "[state-hub] subscriber {} retargeted bot_id={}", sub.id, sub.bot_id
        )

    # -- publish ---------------------------------------------------------

    def publish(
        self,
        frame: Mapping[str, Any],
        *,
        bot_id: str | None = None,
    ) -> None:
        """Schedule *frame* for delivery to matching subscribers.

        Safe to call from any thread / from synchronous request handlers.
        ``bot_id`` is the routing key; ``None`` (or omitted) broadcasts
        to every subscriber.

        The frame dict is *not* deep-copied.  Callers should not mutate
        it after the call.  We add a server-side timestamp (``server_ts``)
        so SPA receivers can ignore stale frames if they ever arrive
        out-of-order on reconnect.
        """
        loop = self._loop
        if loop is None or loop.is_closed():
            # Hub never bound (e.g. console started in degraded mode
            # without lifespan) — silently drop.  Polling/HTTP fallback
            # keeps the UI working.
            return
        payload = dict(frame)
        payload.setdefault("server_ts", time.time())
        target = bot_id or _WILDCARD
        try:
            loop.call_soon_threadsafe(self._dispatch_now, payload, target)
        except RuntimeError:
            # Loop is shutting down; same fallback as above.
            pass

    def _dispatch_now(
        self,
        frame: dict[str, Any],
        target: str,
    ) -> None:
        """Loop-thread enqueue.  Drops oldest frame on overflow."""
        for sub in list(self._subs.values()):
            if target != _WILDCARD and sub.bot_id != _WILDCARD and sub.bot_id != target:
                continue
            queue = sub.queue
            if queue.full():
                # Drop the oldest pending frame to make room.  State
                # frames are deltas; losing one is acceptable because
                # the client either re-syncs on reconnect or via a
                # subsequent fresh frame.
                with contextlib.suppress(asyncio.QueueEmpty):
                    queue.get_nowait()
                logger.warning(
                    "[state-hub] dropped oldest frame for slow subscriber {}",
                    sub.id,
                )
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:  # pragma: no cover - defensive
                logger.warning(
                    "[state-hub] queue still full after drop for {}", sub.id
                )

    # -- helpers ---------------------------------------------------------

    @property
    def subscriber_count(self) -> int:
        return len(self._subs)


# ---------------------------------------------------------------------------
# Module-level accessor
# ---------------------------------------------------------------------------


_hub: StateHub | None = None


def get_state_hub() -> StateHub:
    """Return (creating on first call) the global :class:`StateHub`.

    The hub is not bound to an event loop until
    :func:`bind_state_hub_to_loop` is called, which the FastAPI lifespan
    handler does on startup.  Calls to ``publish`` made before that
    binding are silently dropped (see :meth:`StateHub.publish`).
    """
    global _hub
    if _hub is None:
        _hub = StateHub()
    return _hub


def bind_state_hub_to_loop(loop: asyncio.AbstractEventLoop) -> StateHub:
    """Convenience wrapper used by the FastAPI lifespan."""
    hub = get_state_hub()
    hub.bind_loop(loop)
    return hub


# ---------------------------------------------------------------------------
# Typed convenience publishers
# ---------------------------------------------------------------------------
#
# These wrappers exist so callers do not hand-build the frame dict (and
# accidentally drift from the SPA contract).  The frame shape mirrors
# the ``WSMessage`` types defined in ``src/console/web/src/api/types.ts``.


def publish_status_update(
    bot_id: str | None,
    status: Mapping[str, Any],
) -> None:
    """``{type: status_update, data: StatusResponse & {bot_id}}``."""
    payload: dict[str, Any] = {"type": "status_update"}
    data = dict(status)
    data.setdefault("bot_id", bot_id)
    payload["data"] = data
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_sessions_update(
    bot_id: str | None,
    sessions: list[Mapping[str, Any]],
) -> None:
    """Push the latest session list (matches existing ``sessions_update``)."""
    payload = {
        "type": "sessions_update",
        "data": {"bot_id": bot_id, "sessions": list(sessions)},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_session_deleted(
    bot_id: str | None,
    session_key: str,
) -> None:
    """Notify that *session_key* is gone (covers single + batch deletes)."""
    payload = {
        "type": "session_deleted",
        "data": {"bot_id": bot_id, "session_key": session_key},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_session_message_appended(
    bot_id: str | None,
    session_key: str,
    message: Mapping[str, Any],
) -> None:
    """Stream a single new transcript entry into the open Chat page.

    Replaces the 1.5s ``transcriptSyncTimer`` invalidate-and-refetch
    pattern that Chat.tsx used during long tool calls.
    """
    payload = {
        "type": "session_message_appended",
        "data": {
            "bot_id": bot_id,
            "session_key": session_key,
            "message": dict(message),
        },
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_channels_update(
    bot_id: str | None,
    channels: list[Mapping[str, Any]],
) -> None:
    payload = {
        "type": "channels_update",
        "data": {"bot_id": bot_id, "channels": list(channels)},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_mcp_update(
    bot_id: str | None,
    mcp_servers: list[Mapping[str, Any]],
) -> None:
    payload = {
        "type": "mcp_update",
        "data": {"bot_id": bot_id, "mcp_servers": list(mcp_servers)},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_agents_update(bot_id: str | None) -> None:
    """Hint to the SPA that ``listAgents`` should be refetched.

    Sending the data inline would force the publisher to import the
    agents serializer (cycles), and the SPA already debounces refetches
    via React Query, so a "go invalidate" frame is sufficient.
    """
    payload = {
        "type": "agents_update",
        "data": {"bot_id": bot_id},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_runtime_agents_update(
    bot_id: str | None,
    statuses: list[Mapping[str, Any]],
) -> None:
    """Replace the 4s ``listRuntimeAgents`` refetch interval."""
    payload = {
        "type": "runtime_agents_update",
        "data": {"bot_id": bot_id, "agents": list(statuses)},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_observability_event(
    bot_id: str | None,
    entry: Mapping[str, Any],
) -> None:
    """Push a single observability JSONL row to any open timeline view."""
    payload = {
        "type": "observability_event",
        "data": {"bot_id": bot_id, "entry": dict(entry)},
    }
    get_state_hub().publish(payload, bot_id=bot_id)


def publish_bots_update() -> None:
    """Global frame, no ``bot_id`` filter."""
    payload = {"type": "bots_update", "data": {}}
    get_state_hub().publish(payload, bot_id=None)
