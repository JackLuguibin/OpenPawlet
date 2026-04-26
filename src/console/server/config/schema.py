"""Validated settings schema for the OpenPawlet console server.

Settings are resolved in this priority order (highest wins):

1. Arguments passed to :class:`ServerSettings` directly (``__init__`` kwargs)
2. ``NANOBOT_SERVER_*`` environment variables
3. ``.env`` file in the current working directory (optional)
4. ``~/.nanobot/nanobot_web.json`` under the ``server`` key (optional)
5. Built-in defaults on each field

The JSON file is **opt-in**: it is no longer written automatically on first
boot. See :mod:`loader` for the file location, caching, and explicit
initialization helpers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from pydantic import Field
from pydantic.fields import FieldInfo
from pydantic_settings import (
    BaseSettings,
    PydanticBaseSettingsSource,
    SettingsConfigDict,
)


class JsonServerFileSource(PydanticBaseSettingsSource):
    """Pydantic-settings source that reads the ``server`` section of a JSON file.

    The file path is resolved lazily via :func:`console.server.config.loader
    .find_config_file` so tests can override ``nanobot.config.loader`` state
    without triggering an import cycle at class definition time.
    """

    _SERVER_KEY = "server"

    def __init__(self, settings_cls: type[BaseSettings]) -> None:
        super().__init__(settings_cls)
        self._cached: dict[str, Any] | None = None

    def _load(self) -> dict[str, Any]:
        if self._cached is not None:
            return self._cached
        # Imported lazily to avoid a circular import between loader <-> schema.
        from console.server.config.loader import find_config_file

        path: Path = find_config_file()
        if not path.exists():
            self._cached = {}
            return self._cached
        try:
            with path.open(encoding="utf-8") as f:
                raw: Any = json.load(f)
        except (OSError, json.JSONDecodeError):
            self._cached = {}
            return self._cached
        if not isinstance(raw, dict):
            self._cached = {}
            return self._cached
        server = raw.get(self._SERVER_KEY, {})
        self._cached = server if isinstance(server, dict) else {}
        return self._cached

    def get_field_value(self, field: FieldInfo, field_name: str) -> tuple[Any, str, bool]:
        value = self._load().get(field_name)
        return value, field_name, False

    def __call__(self) -> dict[str, Any]:
        data = self._load()
        return {name: data[name] for name in self.settings_cls.model_fields if name in data}


class ServerSettings(BaseSettings):
    """FastAPI server settings for the OpenPawlet console.

    See the module docstring for the full resolution order.
    """

    model_config = SettingsConfigDict(
        env_prefix="NANOBOT_SERVER_",
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    host: str = Field(default="0.0.0.0", description="Bind address")
    port: int = Field(default=8000, ge=1, le=65535, description="Bind port")
    reload: bool = Field(default=False, description="Enable auto-reload (dev only)")
    log_level: str = Field(default="INFO", description="Loguru log level")
    workers: int = Field(default=1, ge=1, description="Number of worker processes")
    cors_origins: list[str] = Field(default=["*"], description="Allowed CORS origins")
    cors_allow_credentials: bool = Field(
        default=True,
        description=("Send Access-Control-Allow-Credentials; ignored when any origin is '*'"),
    )
    title: str = Field(default="OpenPawlet Console", description="API title")
    description: str = Field(
        default="HTTP API for nanobot console management",
        description="API description",
    )
    version: str = Field(default="0.2.2", description="API version")
    api_prefix: str = Field(default="/api/v1", description="Root path for all routes")
    docs_url: str = Field(
        default="/docs",
        description="Swagger UI path; set to empty string to disable.",
    )
    redoc_url: str = Field(
        default="/redoc",
        description="ReDoc UI path; set to empty string to disable.",
    )
    openapi_url: str = Field(
        default="/openapi.json",
        description="OpenAPI schema path; set to empty string to disable.",
    )
    nanobot_gateway_host: str = Field(
        default="127.0.0.1",
        description=(
            "Loopback host on which the in-process WebSocketChannel listens; "
            "the FastAPI app reverse-proxies /nanobot-ws/* to it."
        ),
    )
    nanobot_gateway_port: int = Field(
        default=8765,
        ge=1,
        le=65535,
        description=(
            "Loopback port on which the in-process WebSocketChannel listens. "
            "Only the console FastAPI server needs to reach it."
        ),
    )

    # ---- Priority wiring ------------------------------------------------
    @classmethod
    def settings_customise_sources(
        cls,
        settings_cls: type[BaseSettings],
        init_settings: PydanticBaseSettingsSource,
        env_settings: PydanticBaseSettingsSource,
        dotenv_settings: PydanticBaseSettingsSource,
        file_secret_settings: PydanticBaseSettingsSource,
    ) -> tuple[PydanticBaseSettingsSource, ...]:
        """Set source priority: init > env > .env > JSON > secrets > defaults."""
        return (
            init_settings,
            env_settings,
            dotenv_settings,
            JsonServerFileSource(settings_cls),
            file_secret_settings,
        )

    # ---- Derived helpers ------------------------------------------------
    @property
    def effective_workers(self) -> int:
        """Worker count for uvicorn (``1`` when ``reload`` is on)."""
        return 1 if self.reload else self.workers

    @property
    def effective_docs_url(self) -> str | None:
        """Swagger UI path, or ``None`` when ``docs_url`` is empty (disabled)."""
        return self.docs_url or None

    @property
    def effective_redoc_url(self) -> str | None:
        """ReDoc path, or ``None`` when ``redoc_url`` is empty (disabled)."""
        return self.redoc_url or None

    @property
    def effective_openapi_url(self) -> str | None:
        """OpenAPI JSON path, or ``None`` when ``openapi_url`` is empty (disabled)."""
        return self.openapi_url or None
