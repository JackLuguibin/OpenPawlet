"""Queue Manager configuration.

Reads from environment variables first (``QUEUE_MANAGER_*``), then from
an optional ``.env`` in the current working directory.  Keeping this
independent from ``NANOBOT_SERVER_*`` avoids coupling operational
concerns of the broker to the console service.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class QueueManagerSettings(BaseSettings):
    """Runtime settings for the Queue Manager broker.

    See the module docstring for source precedence.
    """

    model_config = SettingsConfigDict(
        env_prefix="QUEUE_MANAGER_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    enabled: bool = Field(
        default=True,
        description=(
            "Master switch. When False, producers and consumers fall back to "
            "in-process MessageBus and the broker process exits immediately."
        ),
    )
    host: str = Field(
        default="127.0.0.1",
        description="Bind host for all four ZeroMQ sockets.",
    )
    ingress_port: int = Field(default=7180, ge=1, le=65535)
    worker_port: int = Field(default=7181, ge=1, le=65535)
    egress_port: int = Field(default=7182, ge=1, le=65535)
    delivery_port: int = Field(default=7183, ge=1, le=65535)

    idempotency_window_seconds: int = Field(
        default=900,
        ge=1,
        description="Window for in-memory message_id dedupe (seconds).",
    )
    idempotency_max_entries: int = Field(
        default=200_000,
        ge=1,
        description="Hard cap on tracked message ids before LRU eviction.",
    )
    idempotency_store_path: Path | None = Field(
        default=None,
        description=(
            "Optional append-only file used for cross-restart dedupe. "
            "When None, the store is memory-only."
        ),
    )

    log_level: str = Field(default="INFO")

    health_host: str = Field(
        default="127.0.0.1",
        description="Bind host for the broker health / metrics HTTP endpoint.",
    )
    health_port: int = Field(
        default=7184,
        ge=0,
        le=65535,
        description="Port for ``/health`` and ``/metrics``; set to 0 to disable.",
    )

    admin_token: str = Field(
        default="",
        description=(
            "Bearer token required by admin write endpoints (pause/replay/"
            "dedupe clear) and the /queues/stream WebSocket.  When empty the "
            "admin surface is loopback-only."
        ),
    )
    sample_capacity: int = Field(
        default=100,
        ge=1,
        le=10_000,
        description="Ring buffer size for the recent message samples panel.",
    )
    stream_interval_ms: int = Field(
        default=1000,
        ge=100,
        le=60_000,
        description="Default push cadence for the /queues/stream WebSocket.",
    )

    def ingress_endpoint(self) -> str:
        return f"tcp://{self.host}:{self.ingress_port}"

    def worker_endpoint(self) -> str:
        return f"tcp://{self.host}:{self.worker_port}"

    def egress_endpoint(self) -> str:
        return f"tcp://{self.host}:{self.egress_port}"

    def delivery_endpoint(self) -> str:
        return f"tcp://{self.host}:{self.delivery_port}"

    def bind_ingress_endpoint(self) -> str:
        return f"tcp://*:{self.ingress_port}"

    def bind_worker_endpoint(self) -> str:
        return f"tcp://*:{self.worker_port}"

    def bind_egress_endpoint(self) -> str:
        return f"tcp://*:{self.egress_port}"

    def bind_delivery_endpoint(self) -> str:
        return f"tcp://*:{self.delivery_port}"


@lru_cache(maxsize=1)
def get_settings() -> QueueManagerSettings:
    """Return a cached :class:`QueueManagerSettings` instance."""
    return QueueManagerSettings()
