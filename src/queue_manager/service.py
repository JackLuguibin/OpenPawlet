"""Central ZeroMQ broker process.

Topology (mirrors :class:`nanobot.bus.zmq_bus.ZmqMessageBus`):

::

    producers ──PUSH──▶ ingress  (PULL, bind)
                             │
                             ▼
                        worker  (PUB, bind) ──SUB──▶ agent workers
                             │
                             ▼
    agent workers ──PUSH──▶ egress  (PULL, bind)
                             │
                             ▼
                        delivery(PUB, bind) ──SUB──▶ channel dispatchers

Every frame that flows through the broker is JSON-encoded and carries
the envelope described in :mod:`nanobot.bus.envelope`, so we can dedupe
by ``message_id`` at the broker boundary without having to parse the
payload.

In addition to the message-bus role, this broker also exposes an
admin surface (HTTP + WebSocket) used by the Console "Queues" page to
observe state and drive management operations (pause, replay, clear
dedupe).  See :mod:`queue_manager.admin`.
"""

from __future__ import annotations

import asyncio
import json
import signal
import time
from typing import Any

from loguru import logger

from nanobot import __version__
from nanobot.bus.envelope import (
    KEY_KIND,
    KEY_MESSAGE_ID,
    KEY_SESSION_KEY,
    KEY_TARGET,
    KEY_TRACE_ID,
    TARGET_BROADCAST,
)
from queue_manager.config import QueueManagerSettings
from queue_manager.idempotency import IdempotencyStore
from queue_manager.state import BrokerState, SampleEntry

_SOCKET_EVENT_NAMES = {
    # Filled lazily once pyzmq is imported; see ``_socket_event_name``.
}


def _socket_event_name(zmq_module: Any, event_code: int) -> str:
    """Return a human label for a zmq socket monitor event."""
    if not _SOCKET_EVENT_NAMES:
        for attr in dir(zmq_module):
            if attr.startswith("EVENT_"):
                try:
                    val = getattr(zmq_module, attr)
                except Exception:
                    continue
                if isinstance(val, int):
                    _SOCKET_EVENT_NAMES[val] = attr[len("EVENT_") :]
    return _SOCKET_EVENT_NAMES.get(int(event_code), f"EVENT_{event_code}")


class QueueManagerBroker:
    """Async broker that owns the ZeroMQ sockets and the admin state."""

    def __init__(self, settings: QueueManagerSettings) -> None:
        try:
            import zmq  # type: ignore
            import zmq.asyncio  # type: ignore
        except ImportError as exc:  # pragma: no cover - exercised in install checks
            raise RuntimeError(
                "pyzmq is required for the Queue Manager broker. "
                "Install it with `pip install pyzmq`."
            ) from exc
        self._zmq = zmq
        self._settings = settings
        # Use a fresh Context per broker instance so a process with more
        # than one broker (e.g. integration tests) does not leak state
        # between instances that live in different event loops.
        self._context = zmq.asyncio.Context()

        self._ingress: Any | None = None
        self._worker: Any | None = None
        self._egress: Any | None = None
        self._delivery: Any | None = None
        self._events_ingress: Any | None = None  # PULL from producers
        self._events_delivery: Any | None = None  # PUB to subscribers
        self._monitor_sockets: dict[str, Any] = {}

        self._idempotency = IdempotencyStore(
            window_seconds=settings.idempotency_window_seconds,
            max_entries=settings.idempotency_max_entries,
            persist_path=settings.idempotency_store_path,
        )
        self.state = BrokerState(sample_capacity=settings.sample_capacity)

        self._tasks: list[asyncio.Task[None]] = []
        self._running = False
        self._admin_runner: Any | None = None  # aiohttp.web.AppRunner
        self._start_perf = 0.0

        # Pause gates for each pump direction.
        self._pause_gates: dict[str, asyncio.Event] = {
            "inbound": asyncio.Event(),
            "outbound": asyncio.Event(),
            "events": asyncio.Event(),
        }
        self._pause_gates["inbound"].set()
        self._pause_gates["outbound"].set()
        self._pause_gates["events"].set()

    # ---- lifecycle ------------------------------------------------------
    async def start(self) -> None:
        zmq = self._zmq
        s = self._settings

        self._ingress = self._context.socket(zmq.PULL)
        self._ingress.bind(s.bind_ingress_endpoint())
        self._worker = self._context.socket(zmq.PUB)
        self._worker.bind(s.bind_worker_endpoint())
        self._egress = self._context.socket(zmq.PULL)
        self._egress.bind(s.bind_egress_endpoint())
        self._delivery = self._context.socket(zmq.PUB)
        self._delivery.bind(s.bind_delivery_endpoint())
        self._events_ingress = self._context.socket(zmq.PULL)
        self._events_ingress.bind(s.bind_events_ingress_endpoint())
        self._events_delivery = self._context.socket(zmq.PUB)
        self._events_delivery.bind(s.bind_events_delivery_endpoint())

        logger.info(
            "QueueManagerBroker bound: ingress={} worker={} egress={} delivery={} "
            "events_ingress={} events_delivery={}",
            s.bind_ingress_endpoint(),
            s.bind_worker_endpoint(),
            s.bind_egress_endpoint(),
            s.bind_delivery_endpoint(),
            s.bind_events_ingress_endpoint(),
            s.bind_events_delivery_endpoint(),
        )

        self._start_perf = time.perf_counter()
        self._running = True
        self._tasks.append(
            asyncio.create_task(self._pump("inbound"), name="qm-pump-inbound")
        )
        self._tasks.append(
            asyncio.create_task(self._pump("outbound"), name="qm-pump-outbound")
        )
        self._tasks.append(
            asyncio.create_task(self._pump("events"), name="qm-pump-events")
        )
        self._install_socket_monitors()
        await self._start_admin_server()

    async def stop(self) -> None:
        self._running = False
        for task in self._tasks:
            task.cancel()
        for task in self._tasks:
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
        self._tasks.clear()
        if self._admin_runner is not None:
            try:
                await self._admin_runner.cleanup()
            except Exception:  # pragma: no cover - best effort
                pass
            self._admin_runner = None
        for sock in self._monitor_sockets.values():
            try:
                sock.close(linger=0)
            except Exception:  # pragma: no cover
                pass
        self._monitor_sockets.clear()
        for sock in (
            self._ingress,
            self._worker,
            self._egress,
            self._delivery,
            self._events_ingress,
            self._events_delivery,
        ):
            if sock is not None:
                try:
                    sock.close(linger=0)
                except Exception:  # pragma: no cover
                    pass
        self._ingress = None
        self._worker = None
        self._egress = None
        self._delivery = None
        self._events_ingress = None
        self._events_delivery = None
        try:
            self._context.term()
        except Exception:  # pragma: no cover - best effort
            pass

    async def run_forever(self) -> None:
        """Run until a SIGINT/SIGTERM arrives."""
        await self.start()
        loop = asyncio.get_running_loop()
        stop_event = asyncio.Event()

        def _request_stop(*_: object) -> None:
            stop_event.set()

        for sig in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(sig, _request_stop)
            except NotImplementedError:  # pragma: no cover - Windows fallback
                signal.signal(sig, _request_stop)

        try:
            await stop_event.wait()
        finally:
            await self.stop()

    # ---- admin surface --------------------------------------------------
    def metrics(self) -> dict[str, Any]:
        """Back-compat accessor that mirrors :meth:`snapshot` counters plus dedupe."""
        return {
            **self.state.counters,
            "idempotency": self._idempotency.stats(),
        }

    def topology(self) -> dict[str, Any]:
        s = self._settings
        return {
            "ingress": {
                "role": "PULL",
                "bind": s.bind_ingress_endpoint(),
                "connect_hint": s.ingress_endpoint(),
            },
            "worker": {
                "role": "PUB",
                "bind": s.bind_worker_endpoint(),
                "connect_hint": s.worker_endpoint(),
            },
            "egress": {
                "role": "PULL",
                "bind": s.bind_egress_endpoint(),
                "connect_hint": s.egress_endpoint(),
            },
            "delivery": {
                "role": "PUB",
                "bind": s.bind_delivery_endpoint(),
                "connect_hint": s.delivery_endpoint(),
            },
            "events_ingress": {
                "role": "PULL",
                "bind": s.bind_events_ingress_endpoint(),
                "connect_hint": s.events_ingress_endpoint(),
            },
            "events_delivery": {
                "role": "PUB",
                "bind": s.bind_events_delivery_endpoint(),
                "connect_hint": s.events_delivery_endpoint(),
            },
        }

    def snapshot(self) -> dict[str, Any]:
        """Everything the admin UI wants in one structure."""
        return {
            "status": "ok",
            "version": __version__,
            "uptime_s": round(time.perf_counter() - self._start_perf, 3),
            "settings": {
                "host": self._settings.host,
                "health_host": self._settings.health_host,
                "health_port": self._settings.health_port,
                "sample_capacity": self._settings.sample_capacity,
                "idempotency_window_seconds": self._settings.idempotency_window_seconds,
                "admin_token_configured": bool(self._settings.admin_token),
            },
            "topology": self.topology(),
            "metrics": dict(self.state.counters),
            "rates": self.state.snapshot_rates(),
            "paused": dict(self.state.paused),
            "dedupe": self._idempotency.stats(),
            "connections": [c.as_dict() for c in self.state.connections.list()],
            "samples": [e.as_dict() for e in self.state.samples.list()],
        }

    def set_paused(self, direction: str, paused: bool) -> dict[str, Any]:
        """Flip the pause flag for *direction*.

        Accepted values: ``inbound`` / ``outbound`` / ``events`` /
        ``both`` (inbound + outbound, kept for backward compatibility)
        / ``all`` (every direction).
        """
        changed: list[str] = []
        if direction == "both":
            targets = ["inbound", "outbound"]
        elif direction == "all":
            targets = ["inbound", "outbound", "events"]
        else:
            targets = [direction]
        for d in targets:
            if d not in self._pause_gates:
                raise ValueError(f"unknown direction {d!r}")
            self.state.paused[d] = bool(paused)
            gate = self._pause_gates[d]
            if paused:
                gate.clear()
            else:
                gate.set()
            changed.append(d)
        logger.info(
            "QueueManagerBroker: pump paused={} for {}",
            paused,
            changed,
        )
        return {"paused": dict(self.state.paused), "changed": changed}

    def clear_dedupe(self, scope: str = "memory") -> dict[str, Any]:
        result = self._idempotency.clear(scope=scope)
        self.state.incr("dedupe_clears", 1)
        logger.info("QueueManagerBroker: dedupe clear scope={} result={}", scope, result)
        return result

    async def replay_message(self, message_id: str) -> dict[str, Any]:
        """Re-publish a previously seen envelope identified by *message_id*."""
        entry = self.state.samples.find(message_id)
        if entry is None:
            raise KeyError(message_id)
        if entry.direction == "inbound":
            outbox = self._worker
        elif entry.direction == "events":
            outbox = self._events_delivery
        else:
            outbox = self._delivery
        if outbox is None:
            raise RuntimeError("broker is not running")
        # Bypass dedupe for the replay by dropping the cached key so the
        # subsequent publish does not re-enter it.
        self._idempotency.forget(message_id)
        if entry.direction == "events":
            # Events frames are multipart [target, payload] on the wire.
            try:
                envelope = json.loads(entry.raw.decode("utf-8"))
            except Exception:
                envelope = {}
            target = str(envelope.get(KEY_TARGET, TARGET_BROADCAST) or TARGET_BROADCAST)
            await outbox.send_multipart([target.encode("utf-8"), entry.raw])
        else:
            await outbox.send(entry.raw)
        self.state.incr("replayed", 1)
        self.state.incr(f"{entry.direction}_forwarded", 1)
        self.state.incr(f"{entry.direction}_bytes_total", entry.bytes_len)
        return {"message_id": message_id, "direction": entry.direction}

    # ---- pumps ----------------------------------------------------------
    async def _pump(self, direction: str) -> None:
        """Forward frames for one direction.

        - inbound:  ingress → worker (single-frame JSON)
        - outbound: egress  → delivery (single-frame JSON)
        - events:   events_ingress → events_delivery (multipart: [target, json])
        """
        is_events = direction == "events"
        if direction == "inbound":
            inbox = self._ingress
            outbox = self._worker
        elif direction == "events":
            inbox = self._events_ingress
            outbox = self._events_delivery
        else:
            inbox = self._egress
            outbox = self._delivery
        assert inbox is not None and outbox is not None
        gate = self._pause_gates[direction]
        forwarded_key = f"{direction}_forwarded"
        dedupe_key = f"{direction}_dropped_duplicate"
        paused_key = f"{direction}_dropped_paused"
        bytes_key = f"{direction}_bytes_total"
        try:
            while self._running:
                await gate.wait()
                if is_events:
                    frames = await inbox.recv_multipart()
                    if len(frames) >= 2:
                        target_bytes = frames[0]
                        data = frames[1]
                    else:
                        # Backward-compatible single-frame path - fall
                        # back to parsing the target out of the payload.
                        data = frames[0]
                        try:
                            target_bytes = str(
                                json.loads(data.decode("utf-8")).get(
                                    KEY_TARGET, TARGET_BROADCAST
                                )
                            ).encode("utf-8")
                        except Exception:
                            target_bytes = TARGET_BROADCAST.encode("utf-8")
                else:
                    target_bytes = b""
                    data = await inbox.recv()
                if not gate.is_set():
                    # Paused while we were reading; drop this frame so the
                    # PULL queue does not balloon.  Admins can replay via
                    # the UI once they resume.
                    self.state.incr(paused_key, 1)
                    continue
                try:
                    envelope = json.loads(data.decode("utf-8"))
                except Exception:
                    self.state.incr("malformed_frames", 1)
                    continue
                mid = str(envelope.get(KEY_MESSAGE_ID, ""))
                if not self._idempotency.try_accept(mid):
                    self.state.incr(dedupe_key, 1)
                    logger.debug(
                        "QueueManagerBroker: duplicate {} dropped (message_id={})",
                        direction,
                        mid,
                    )
                    continue
                if is_events:
                    await outbox.send_multipart([target_bytes, data])
                else:
                    await outbox.send(data)
                self.state.incr(forwarded_key, 1)
                self.state.incr(bytes_key, len(data))
                if is_events:
                    session_key = target_bytes.decode("utf-8", errors="replace")
                else:
                    session_key = str(envelope.get(KEY_SESSION_KEY, ""))
                self.state.record_sample(
                    SampleEntry(
                        at=time.time(),
                        direction=direction,
                        kind=str(envelope.get(KEY_KIND, "")),
                        message_id=mid,
                        session_key=session_key,
                        bytes_len=len(data),
                        trace_id=str(envelope.get(KEY_TRACE_ID, "")),
                        raw=data,
                    )
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover - surfaced only on socket errors
            logger.exception("QueueManagerBroker {} pump crashed: {}", direction, exc)

    # ---- socket monitors ------------------------------------------------
    def _install_socket_monitors(self) -> None:
        """Hook ZeroMQ socket_monitor on every bind socket for live connection info."""
        zmq = self._zmq
        targets = {
            "ingress": self._ingress,
            "worker": self._worker,
            "egress": self._egress,
            "delivery": self._delivery,
            "events_ingress": self._events_ingress,
            "events_delivery": self._events_delivery,
        }
        for name, sock in targets.items():
            if sock is None:
                continue
            monitor_addr = f"inproc://qm-monitor-{name}-{id(sock)}"
            try:
                sock.monitor(monitor_addr, zmq.EVENT_ALL)
            except Exception as exc:  # pragma: no cover
                logger.warning(
                    "QueueManagerBroker: monitor attach failed for {}: {}", name, exc
                )
                continue
            monitor_sock = self._context.socket(zmq.PAIR)
            monitor_sock.connect(monitor_addr)
            self._monitor_sockets[name] = monitor_sock
            task = asyncio.create_task(
                self._monitor_loop(name, monitor_sock),
                name=f"qm-monitor-{name}",
            )
            self._tasks.append(task)

    async def _monitor_loop(self, socket_name: str, monitor_sock: Any) -> None:
        """Translate raw ZeroMQ monitor frames into :class:`ConnectionEntry` updates."""
        zmq = self._zmq
        try:
            while self._running:
                # Monitor frames are 2 parts: (event+value packed) + endpoint bytes.
                try:
                    frames = await monitor_sock.recv_multipart()
                except Exception:
                    break
                if len(frames) < 2:
                    continue
                payload = frames[0]
                endpoint = frames[1]
                if len(payload) < 6:
                    continue
                event = int.from_bytes(payload[:2], byteorder="little", signed=False)
                try:
                    peer = endpoint.decode("utf-8", errors="replace")
                except Exception:
                    peer = str(endpoint)
                event_name = _socket_event_name(zmq, event)
                self.state.connections.observe(
                    socket=socket_name,
                    peer=peer,
                    event=event_name,
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # pragma: no cover
            logger.exception(
                "QueueManagerBroker monitor loop ({}) crashed: {}", socket_name, exc
            )

    # ---- admin HTTP / WS ------------------------------------------------
    async def _start_admin_server(self) -> None:
        s = self._settings
        if s.health_port <= 0:
            return
        # Defer importing the admin module so the broker still boots if
        # aiohttp is missing (only required when the admin surface is on).
        from queue_manager.admin import build_admin_app

        app = build_admin_app(self)
        try:
            from aiohttp import web
        except ImportError as exc:  # pragma: no cover
            logger.warning(
                "QueueManagerBroker: aiohttp missing ({}); admin HTTP disabled.",
                exc,
            )
            return
        runner = web.AppRunner(app)
        await runner.setup()
        site = web.TCPSite(runner, host=s.health_host, port=s.health_port)
        await site.start()
        self._admin_runner = runner
        logger.info(
            "QueueManagerBroker admin endpoint: http://{}:{}/queues/snapshot",
            s.health_host,
            s.health_port,
        )
