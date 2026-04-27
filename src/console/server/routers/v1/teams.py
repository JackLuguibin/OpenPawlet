"""Teams API: groups of console agents, rooms, and merged transcripts."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, status

from console.server.bot_workspace import (
    clear_active_team_gateway_for_team,
    iso_now,
    load_json_file,
    new_id,
    save_active_team_gateway,
    save_json_file,
    set_bot_running,
    teams_state_path,
)
from console.server.models import (
    AddTeamMemberBody,
    DataResponse,
    MergedTranscriptEntry,
    OkBody,
    Team,
    TeamCreateRequest,
    TeamRoom,
    TeamRoomCreateResponse,
    TeamRoomDeleteResponse,
    TeamTranscriptResponse,
    TeamUpdateRequest,
    UpdateTeamMemberBody,
)
from console.server.parsing import parse_model_list
from console.server.services.agents_state import list_agent_ids, list_agents
from console.server.team_transcript import merge_team_transcript, team_member_session_key

router = APIRouter(prefix="/bots/{bot_id}/teams", tags=["Teams"])


def _load_teams_state(bot_id: str) -> dict[str, Any]:
    path = teams_state_path(bot_id)
    data = load_json_file(path, None)
    if not isinstance(data, dict):
        return {"teams": [], "rooms": []}
    teams = data.get("teams")
    if not isinstance(teams, list):
        teams = []
    rooms = data.get("rooms")
    if not isinstance(rooms, list):
        rooms = []
    return {"teams": teams, "rooms": rooms}


def _parse_teams(raw_list: list[Any]) -> list[Team]:
    return parse_model_list(raw_list, Team)


def _parse_rooms(raw_list: list[Any]) -> list[TeamRoom]:
    return parse_model_list(raw_list, TeamRoom)


def _save_teams_state(bot_id: str, *, teams: list[Team], rooms: list[TeamRoom]) -> None:
    path = teams_state_path(bot_id)
    payload = {
        "teams": [t.model_dump(mode="json") for t in teams],
        "rooms": [r.model_dump(mode="json") for r in rooms],
    }
    save_json_file(path, payload)


def _agent_id_set(bot_id: str) -> set[str]:
    return list_agent_ids(bot_id)


def _get_team(teams: list[Team], team_id: str) -> Team:
    for t in teams:
        if t.id == team_id:
            return t
    raise HTTPException(status_code=404, detail="Team not found")


def _normalize_member_ephemeral(
    member_ids: list[str],
    raw_map: dict[str, bool] | None,
) -> dict[str, bool]:
    """Constrain ephemeral flags to current member ids."""
    normalized: dict[str, bool] = {}
    members = set(member_ids)
    for aid, flag in (raw_map or {}).items():
        if aid in members and bool(flag):
            normalized[aid] = True
    return normalized


@router.get("", response_model=DataResponse[list[Team]])
async def list_teams(bot_id: str) -> DataResponse[list[Team]]:
    raw = _load_teams_state(bot_id)
    return DataResponse(data=_parse_teams(raw["teams"]))


@router.post("", response_model=DataResponse[Team], status_code=status.HTTP_200_OK)
async def create_team(bot_id: str, body: TeamCreateRequest) -> DataResponse[Team]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    tid = (body.id or "").strip() or new_id("tm-")
    if any(t.id == tid for t in teams):
        raise HTTPException(status_code=400, detail="Team id already exists")
    members = list(body.member_agent_ids or [])
    valid = _agent_id_set(bot_id)
    for aid in members:
        if aid not in valid:
            raise HTTPException(status_code=400, detail=f"Unknown agent_id: {aid}")
    team = Team(
        id=tid,
        name=body.name.strip(),
        description=body.description,
        member_agent_ids=members,
        member_ephemeral=_normalize_member_ephemeral(members, body.member_ephemeral),
        team_skills=list(body.team_skills or []),
        context_notes=body.context_notes,
        created_at=iso_now(),
    )
    teams.append(team)
    if members:
        room_id = new_id("room-")
        rooms.append(TeamRoom(id=room_id, team_id=tid, created_at=iso_now()))
        _save_teams_state(bot_id, teams=teams, rooms=rooms)
        save_active_team_gateway(bot_id, tid, room_id)
    else:
        _save_teams_state(bot_id, teams=teams, rooms=rooms)
    set_bot_running(bot_id, True)
    return DataResponse(data=team)


@router.get("/{team_id}", response_model=DataResponse[Team])
async def get_team(bot_id: str, team_id: str) -> DataResponse[Team]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    return DataResponse(data=_get_team(teams, team_id))


@router.put("/{team_id}", response_model=DataResponse[Team])
async def update_team(
    bot_id: str,
    team_id: str,
    body: TeamUpdateRequest,
) -> DataResponse[Team]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    t = _get_team(teams, team_id)
    t = Team(
        id=t.id,
        name=body.name.strip() if body.name is not None else t.name,
        description=body.description if body.description is not None else t.description,
        member_agent_ids=t.member_agent_ids,
        member_ephemeral=t.member_ephemeral,
        team_skills=list(body.team_skills) if body.team_skills is not None else t.team_skills,
        context_notes=body.context_notes if body.context_notes is not None else t.context_notes,
        created_at=t.created_at,
    )
    teams = [x if x.id != team_id else t for x in teams]
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    return DataResponse(data=t)


@router.delete("/{team_id}", response_model=DataResponse[OkBody])
async def delete_team(bot_id: str, team_id: str) -> DataResponse[OkBody]:
    raw = _load_teams_state(bot_id)
    teams = [t for t in _parse_teams(raw["teams"]) if t.id != team_id]
    rooms = [r for r in _parse_rooms(raw["rooms"]) if r.team_id != team_id]
    if len(teams) == len(_parse_teams(raw["teams"])):
        raise HTTPException(status_code=404, detail="Team not found")
    clear_active_team_gateway_for_team(bot_id, team_id)
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    return DataResponse(data=OkBody())


@router.post("/{team_id}/members", response_model=DataResponse[Team])
async def add_team_member(
    bot_id: str,
    team_id: str,
    body: AddTeamMemberBody,
) -> DataResponse[Team]:
    valid = _agent_id_set(bot_id)
    if body.agent_id not in valid:
        raise HTTPException(status_code=400, detail="Unknown agent_id")
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    t = _get_team(teams, team_id)
    if body.agent_id in t.member_agent_ids:
        raise HTTPException(status_code=400, detail="Agent already in team")
    new_ids = list(t.member_agent_ids) + [body.agent_id]
    updated = Team(
        id=t.id,
        name=t.name,
        description=t.description,
        member_agent_ids=new_ids,
        member_ephemeral=_normalize_member_ephemeral(
            new_ids,
            {**t.member_ephemeral, body.agent_id: bool(body.ephemeral_session or False)},
        ),
        team_skills=t.team_skills,
        context_notes=t.context_notes,
        created_at=t.created_at,
    )
    teams = [updated if x.id == team_id else x for x in teams]
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    set_bot_running(bot_id, True)
    return DataResponse(data=updated)


@router.delete("/{team_id}/members/{agent_id}", response_model=DataResponse[Team])
async def remove_team_member(
    bot_id: str,
    team_id: str,
    agent_id: str,
) -> DataResponse[Team]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    t = _get_team(teams, team_id)
    if agent_id not in t.member_agent_ids:
        raise HTTPException(status_code=400, detail="Agent not in team")
    new_ids = [x for x in t.member_agent_ids if x != agent_id]
    updated = Team(
        id=t.id,
        name=t.name,
        description=t.description,
        member_agent_ids=new_ids,
        member_ephemeral=_normalize_member_ephemeral(
            new_ids,
            {k: v for k, v in t.member_ephemeral.items() if k != agent_id},
        ),
        team_skills=t.team_skills,
        context_notes=t.context_notes,
        created_at=t.created_at,
    )
    teams = [updated if x.id == team_id else x for x in teams]
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    set_bot_running(bot_id, True)
    return DataResponse(data=updated)


@router.patch("/{team_id}/members/{agent_id}", response_model=DataResponse[Team])
async def update_team_member(
    bot_id: str,
    team_id: str,
    agent_id: str,
    body: UpdateTeamMemberBody,
) -> DataResponse[Team]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    t = _get_team(teams, team_id)
    if agent_id not in t.member_agent_ids:
        raise HTTPException(status_code=400, detail="Agent not in team")
    member_ephemeral = dict(t.member_ephemeral)
    if body.ephemeral_session is not None:
        if body.ephemeral_session:
            member_ephemeral[agent_id] = True
        else:
            member_ephemeral.pop(agent_id, None)
    updated = Team(
        id=t.id,
        name=t.name,
        description=t.description,
        member_agent_ids=t.member_agent_ids,
        member_ephemeral=_normalize_member_ephemeral(t.member_agent_ids, member_ephemeral),
        team_skills=t.team_skills,
        context_notes=t.context_notes,
        created_at=t.created_at,
    )
    teams = [updated if x.id == team_id else x for x in teams]
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    set_bot_running(bot_id, True)
    return DataResponse(data=updated)


@router.post(
    "/{team_id}/rooms",
    response_model=DataResponse[TeamRoomCreateResponse],
    status_code=status.HTTP_200_OK,
)
async def create_team_room(bot_id: str, team_id: str) -> DataResponse[TeamRoomCreateResponse]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    rooms = _parse_rooms(raw["rooms"])
    t = _get_team(teams, team_id)
    if not t.member_agent_ids:
        raise HTTPException(status_code=400, detail="Team has no members")
    room_id = new_id("room-")
    tr = TeamRoom(id=room_id, team_id=team_id, created_at=iso_now())
    rooms.append(tr)
    _save_teams_state(bot_id, teams=teams, rooms=rooms)
    save_active_team_gateway(bot_id, team_id, room_id)
    set_bot_running(bot_id, True)
    keys: dict[str, str] = {
        aid: team_member_session_key(team_id, room_id, aid) for aid in t.member_agent_ids
    }
    return DataResponse(data=TeamRoomCreateResponse(room=tr, member_session_keys=keys))


@router.get(
    "/{team_id}/rooms",
    response_model=DataResponse[list[TeamRoom]],
)
async def list_team_rooms(bot_id: str, team_id: str) -> DataResponse[list[TeamRoom]]:
    raw = _load_teams_state(bot_id)
    _get_team(_parse_teams(raw["teams"]), team_id)
    rooms = [r for r in _parse_rooms(raw["rooms"]) if r.team_id == team_id]
    return DataResponse(data=rooms)


@router.delete(
    "/{team_id}/rooms/{room_id}",
    response_model=DataResponse[TeamRoomDeleteResponse],
)
async def delete_team_room(
    bot_id: str, team_id: str, room_id: str
) -> DataResponse[TeamRoomDeleteResponse]:
    raw = _load_teams_state(bot_id)
    teams = _parse_teams(raw["teams"])
    _get_team(teams, team_id)
    rooms = _parse_rooms(raw["rooms"])
    target = next((r for r in rooms if r.team_id == team_id and r.id == room_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="Room not found")
    kept_rooms = [r for r in rooms if not (r.team_id == team_id and r.id == room_id)]
    _save_teams_state(bot_id, teams=teams, rooms=kept_rooms)
    clear_active_team_gateway_for_team(bot_id, team_id)
    next_room = next((r for r in kept_rooms if r.team_id == team_id), None)
    if next_room is not None:
        save_active_team_gateway(bot_id, team_id, next_room.id)
    set_bot_running(bot_id, True)
    return DataResponse(data=TeamRoomDeleteResponse(room_id=room_id))


@router.get(
    "/{team_id}/rooms/{room_id}/transcript",
    response_model=DataResponse[TeamTranscriptResponse],
)
async def get_team_room_transcript(
    bot_id: str,
    team_id: str,
    room_id: str,
) -> DataResponse[TeamTranscriptResponse]:
    raw = _load_teams_state(bot_id)
    t = _get_team(_parse_teams(raw["teams"]), team_id)
    rlist = _parse_rooms(raw["rooms"])
    if not any(r.id == room_id and r.team_id == team_id for r in rlist):
        raise HTTPException(status_code=404, detail="Room not found")
    agents = list_agents(bot_id)
    id_to_name = {a.id: a.name for a in agents}
    keys, rows = merge_team_transcript(
        bot_id,
        team_id=team_id,
        room_id=room_id,
        member_agent_ids=t.member_agent_ids,
        id_to_name=id_to_name,
    )
    merged = [
        MergedTranscriptEntry(
            agent_id=str(r["agent_id"]),
            agent_name=r.get("agent_name"),
            session_key=str(r["session_key"]),
            role=str(r["role"]),
            content=str(r["content"]),
            timestamp=r.get("timestamp"),
            source=r.get("source"),
        )
        for r in rows
    ]
    return DataResponse(
        data=TeamTranscriptResponse(
            team_id=team_id,
            room_id=room_id,
            messages=merged,
            member_session_keys=keys,
        )
    )
