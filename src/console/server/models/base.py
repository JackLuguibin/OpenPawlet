"""Base response models shared by API payloads."""

from __future__ import annotations

from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict

T = TypeVar("T")


class OkBody(BaseModel):
    """Stub success body with a ``status`` field (common in the web client)."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"


class OkWithKey(BaseModel):
    """``{ status, key }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    key: str


class OkWithName(BaseModel):
    """``{ status, name }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    name: str


class OkWithJobId(BaseModel):
    """``{ status, job_id }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    job_id: str


class OkWithPath(BaseModel):
    """``{ status, path }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    path: str


class OkWithAgentId(BaseModel):
    """``{ status, agent_id }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    agent_id: str


class OkWithTopic(BaseModel):
    """``{ status, topic }`` style response."""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    topic: str


class BaseResponse(BaseModel):
    """Shared fields for all API responses."""

    model_config = ConfigDict(extra="forbid")


class DataResponse(BaseResponse, Generic[T]):
    """Wrapper for responses that carry a data payload.

    Matches the web client's success envelope: ``code == 0`` unwraps ``data``.
    """

    code: int = 0
    message: str = "success"
    data: T
