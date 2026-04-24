# Queue Manager

Central ZeroMQ broker that sits between OpenPawlet producers (Console,
cron, heartbeat, channels) and consumers (Nanobot agent, channel
dispatchers).  It provides:

- A single wire-format ``message_id`` / ``dedupe_key`` / ``event_seq``
  envelope so every hop can participate in business-level
  "exactly once" delivery.
- An in-memory LRU idempotency store, optionally persisted to a JSONL
  file for cross-restart dedupe.
- A lightweight ``/health`` + ``/metrics`` HTTP endpoint.

## Running

```
open-pawlet-queue-manager
```

Configuration lives in environment variables with the
``QUEUE_MANAGER_`` prefix (see `config.py`).  The most common knobs:

| Variable                          | Default   | Purpose                                |
|-----------------------------------|-----------|----------------------------------------|
| `QUEUE_MANAGER_ENABLED`           | `true`    | Master switch. Set to `false` to exit. |
| `QUEUE_MANAGER_HOST`              | `127.0.0.1` | Bind host for ZeroMQ sockets.         |
| `QUEUE_MANAGER_INGRESS_PORT`      | `7180`    | Producers → broker (PUSH / PULL).       |
| `QUEUE_MANAGER_WORKER_PORT`       | `7181`    | Broker → agents (PUB / SUB).            |
| `QUEUE_MANAGER_EGRESS_PORT`       | `7182`    | Agents → broker (PUSH / PULL).          |
| `QUEUE_MANAGER_DELIVERY_PORT`     | `7183`    | Broker → dispatchers (PUB / SUB).       |
| `QUEUE_MANAGER_EVENTS_INGRESS_PORT`  | `7184` | Events producers → broker (PUSH / PULL). |
| `QUEUE_MANAGER_EVENTS_DELIVERY_PORT` | `7185` | Broker → event subscribers (PUB / SUB).  |
| `QUEUE_MANAGER_HEALTH_PORT`       | `7186`    | HTTP admin: `/health`, `/queues/snapshot`, `/queues/stream`. 0 disables.|
| `QUEUE_MANAGER_IDEMPOTENCY_WINDOW_SECONDS` | `900` | Dedupe window.                     |
| `QUEUE_MANAGER_IDEMPOTENCY_STORE_PATH` | —    | Optional persistence file.             |

The OpenPawlet Console uses `NANOBOT_SERVER_QUEUE_MANAGER_ADMIN_PORT` (default `7186`); it must match `QUEUE_MANAGER_HEALTH_PORT` so the Queues page can proxy to the broker.

## Events channel (agent pub/sub)

In addition to the inbound/outbound channels the broker exposes a
dedicated **events** channel for agent-to-agent collaboration and
system event fan-out.  Producers PUSH events to
`QUEUE_MANAGER_EVENTS_INGRESS_PORT`; every subscriber SUBSCRIBEs on
`QUEUE_MANAGER_EVENTS_DELIVERY_PORT`.

Events carry an :class:`AgentEvent` envelope (`kind="event"`) with
three pub/sub-specific fields:

- `topic`        semantic label, e.g. `cron.fired`, `chat.new`.
- `source_agent` identifier of the producer (defaults to `system` for
  channel/cron producers, `main:<host>:<pid>` for the main agent,
  `sub:<task_id>` for subagents).
- `target`       wire-level routing prefix that SUB sockets filter on:
  - `broadcast`        - every subscriber receives it.
  - `agent:<agent_id>` - direct message to a single agent.
  - `topic:<name>`     - everyone subscribed to that topic.

The broker wraps events into multipart ZMQ frames
`[target, envelope_json]` so subscribers can filter by the first frame
without parsing JSON, and nothing routing-related happens in the broker
itself - it forwards what producers send and lets SUB-side prefix
filtering decide who receives it.

Delivery semantics are **at-most-once**: events are not buffered, and
subscribers that connect after a publish will not see it.  Events are
still deduped by `message_id` at the broker boundary, and appear in the
Console Queues page (same sample buffer as inbound/outbound).

### System producers

The gateway publishes these events out of the box when the broker is
enabled:

| Topic            | Producer                     | Target      |
|------------------|------------------------------|-------------|
| `cron.fired`     | `system:cron`                | broadcast   |
| `channel.up`     | `system:channel-manager`     | broadcast   |
| `channel.down`   | `system:channel-manager`     | broadcast   |
| `subagent.done`  | `sub:<task_id>`              | broadcast   |
| `agent.direct`   | any agent (via `send_to_agent`) | `agent:<id>` |

Agents opt in to receiving events via the `publish_event`,
`send_to_agent`, and `subscribe_event` tools.  See the AGENTS.md
template for the tool-level guide.

## Rollback

Turn the broker off by setting `QUEUE_MANAGER_ENABLED=false` in the
gateway's environment; the Nanobot gateway and channels transparently
fall back to the in-process ``MessageBus`` (which also implements the
events surface, minus the cross-process fan-out).  The Procfile entry
and ``open-pawlet start`` both propagate this flag automatically.
