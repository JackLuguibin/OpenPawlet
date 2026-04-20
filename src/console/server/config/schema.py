"""Validated settings schema for the nanobot-web server.

JSON file reads and the cached singleton live in :mod:`loader`. Environment
variables and optional ``.env`` loading are handled by pydantic-settings on
:class:`ServerSettings` construction.
"""

from __future__ import annotations

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ServerSettings(BaseSettings):
    """FastAPI server settings loaded from env / nanobot_web.json / defaults."""

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
    cors_origins: list[str] = Field(
        default=["*"], description="Allowed CORS origins"
    )
    cors_allow_credentials: bool = Field(
        default=True,
        description=(
            "Send Access-Control-Allow-Credentials; ignored when any origin is '*'"
        ),
    )
    title: str = Field(default="OpenPawlet Console", description="API title")
    description: str = Field(
        default="HTTP API for nanobot console management",
        description="API description",
    )
    version: str = Field(default="0.2.2", description="API version")
    api_prefix: str = Field(default="/api/v1", description="Root path for all routes")
    docs_url: str = Field(default="/docs", description="OpenAPI docs path")
    redoc_url: str = Field(default="/redoc", description="ReDoc UI path")
    openapi_url: str = Field(default="/openapi.json", description="OpenAPI schema path")

    @property
    def effective_workers(self) -> int:
        """Worker count for uvicorn (``1`` when ``reload`` is on)."""
        return 1 if self.reload else self.workers

    @property
    def effective_docs_url(self) -> str | None:
        """Swagger UI path, or ``None`` when ``reload`` is enabled (dev hides docs)."""
        return None if self.reload else self.docs_url

    @property
    def effective_redoc_url(self) -> str | None:
        """ReDoc path, or ``None`` when ``reload`` is enabled (dev hides docs)."""
        return None if self.reload else self.redoc_url

    @property
    def effective_openapi_url(self) -> str | None:
        """OpenAPI JSON path, or ``None`` when ``reload`` is enabled."""
        return None if self.reload else self.openapi_url
