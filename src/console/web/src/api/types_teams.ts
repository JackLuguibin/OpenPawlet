export interface Team {
  id: string;
  name: string;
  description: string | null;
  member_agent_ids: string[];
  member_ephemeral: Record<string, boolean>;
  team_skills: string[];
  context_notes: string | null;
  created_at: string;
}

export interface TeamCreateRequest {
  id?: string | null;
  name: string;
  description?: string | null;
  member_agent_ids?: string[];
  member_ephemeral?: Record<string, boolean>;
  team_skills?: string[];
  context_notes?: string | null;
}

export interface TeamUpdateRequest {
  name?: string;
  description?: string | null;
  team_skills?: string[];
  context_notes?: string | null;
}

export interface TeamRoom {
  id: string;
  team_id: string;
  created_at: string;
}

export interface TeamRoomCreateResponse {
  room: TeamRoom;
  member_session_keys: Record<string, string>;
}

export interface TeamRoomDeleteResponse {
  room_id: string;
}

export interface MergedTranscriptEntry {
  agent_id: string;
  agent_name: string | null;
  session_key: string;
  role: string;
  content: string;
  timestamp: string | null;
  source: string | null;
}

export interface TeamTranscriptResponse {
  team_id: string;
  room_id: string;
  messages: MergedTranscriptEntry[];
  member_session_keys: Record<string, string>;
}
