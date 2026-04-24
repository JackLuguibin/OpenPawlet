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
| `QUEUE_MANAGER_HEALTH_PORT`       | `7184`    | HTTP `/health` + `/metrics`. 0 disables.|
| `QUEUE_MANAGER_IDEMPOTENCY_WINDOW_SECONDS` | `900` | Dedupe window.                     |
| `QUEUE_MANAGER_IDEMPOTENCY_STORE_PATH` | —    | Optional persistence file.             |

## Rollback

Turn the broker off by setting `QUEUE_MANAGER_ENABLED=false` in the
gateway's environment; the Nanobot gateway and channels transparently
fall back to the in-process ``MessageBus``.  The Procfile entry and
``open-pawlet start`` both propagate this flag automatically.
