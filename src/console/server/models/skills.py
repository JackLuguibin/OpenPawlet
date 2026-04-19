"""Skills registry and workspace skill models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict


class SkillInfo(BaseModel):
    """Skill list row."""

    model_config = ConfigDict(extra="forbid")

    name: str
    source: Literal["builtin", "workspace"]
    description: str
    enabled: bool
    path: str | None = None
    available: bool | None = None


class SkillContentBody(BaseModel):
    """PUT /skills/{name}/content body."""

    model_config = ConfigDict(extra="forbid")

    content: str


class SkillContentResponse(BaseModel):
    """GET /skills/{name}/content."""

    model_config = ConfigDict(extra="forbid")

    name: str
    content: str


class SkillCreateBody(BaseModel):
    """POST /skills body."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str
    content: str = ""
    files: dict[str, str] | None = None
    directories: list[str] | None = None


class SkillBundleUpdateBody(BaseModel):
    """PUT /skills/{name}/bundle body."""

    model_config = ConfigDict(extra="forbid")

    content: str = ""
    files: dict[str, str] | None = None
    directories: list[str] | None = None
    delete_rels: list[str] | None = None


class RegistrySearchItem(BaseModel):
    """Remote registry search hit."""

    model_config = ConfigDict(extra="forbid")

    name: str
    description: str | None = None
    url: str | None = None
    version: str | None = None


class InstallFromRegistryBody(BaseModel):
    """POST /skills/install-from-registry body."""

    model_config = ConfigDict(extra="forbid")

    name: str
    registry_url: str | None = None
