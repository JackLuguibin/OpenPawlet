"""Configuration section models (nanobot ``config.json`` envelope)."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ConfigSection(BaseModel):
    """Full ``config.json`` document (camelCase keys; extra keys allowed)."""

    model_config = ConfigDict(extra="allow")


class ConfigPutBody(BaseModel):
    """PUT /config body."""

    model_config = ConfigDict(extra="forbid")

    section: str = Field(min_length=1)
    data: dict[str, Any]

    @field_validator("section")
    @classmethod
    def strip_section(cls, value: str) -> str:
        """Reject whitespace-only section names."""
        stripped = value.strip()
        if not stripped:
            msg = "section must not be empty"
            raise ValueError(msg)
        return stripped


class ConfigValidateResponse(BaseModel):
    """POST /config/validate response."""

    model_config = ConfigDict(extra="forbid")

    valid: bool
    errors: list[str]
