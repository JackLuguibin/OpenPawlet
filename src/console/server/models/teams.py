"""Team / multi-agent room models (console JSON persistence)."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field


class Team(BaseModel):
    """Team record: named group of console agent ids."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str | None = None
    member_agent_ids: list[str] = Field(default_factory=list)
    member_ephemeral: dict[str, bool] = Field(default_factory=dict)
    team_skills: list[str] = Field(default_factory=list)
    context_notes: str | None = None
    created_at: str


class TeamCreateRequest(BaseModel):
    """POST create team."""

    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    name: str
    description: str | None = None
    member_agent_ids: list[str] | None = None
    member_ephemeral: dict[str, bool] | None = None
    team_skills: list[str] | None = None
    context_notes: str | None = None


class TeamUpdateRequest(BaseModel):
    """PUT update team."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = None
    description: str | None = None
    team_skills: list[str] | None = None
    context_notes: str | None = None


class AddTeamMemberBody(BaseModel):
    """POST add member to team."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    ephemeral_session: bool | None = None


class UpdateTeamMemberBody(BaseModel):
    """PATCH update team member runtime preferences."""

    model_config = ConfigDict(extra="forbid")

    ephemeral_session: bool | None = None


class TeamRoom(BaseModel):
    """A collaboration room under a team (parallel sessions share one room id)."""

    model_config = ConfigDict(extra="forbid")

    id: str
    team_id: str
    created_at: str


class TeamRoomCreateResponse(BaseModel):
    """Response after creating a room."""

    model_config = ConfigDict(extra="forbid")

    room: TeamRoom
    member_session_keys: dict[str, str]


class TeamRoomDeleteResponse(BaseModel):
    """Response after deleting a room."""

    model_config = ConfigDict(extra="forbid")

    room_id: str


class MergedTranscriptEntry(BaseModel):
    """One message in a merged team timeline."""

    model_config = ConfigDict(extra="forbid")

    agent_id: str
    agent_name: str | None = None
    session_key: str
    role: str
    content: str
    timestamp: str | None = None
    source: str | None = None


class TeamTranscriptResponse(BaseModel):
    """Merged transcript for a team room."""

    model_config = ConfigDict(extra="forbid")

    team_id: str
    room_id: str
    messages: list[MergedTranscriptEntry]
    member_session_keys: dict[str, str]
