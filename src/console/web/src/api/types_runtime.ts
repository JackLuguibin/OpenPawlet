// Runtime agent management types (matches backend ``console.server.models.agent_runtime``).

/** main = primary agent loop; sub = managed subagent task. */
export type RuntimeAgentRole = 'main' | 'sub';

export interface RuntimeAgentStatus {
  agent_id: string;
  role: RuntimeAgentRole;
  running: boolean;
  phase?: string | null;
  started_at?: number | null;
  uptime_seconds?: number | null;
  parent_agent_id?: string | null;
  team_id?: string | null;
  label?: string | null;
  task_description?: string | null;
  iteration?: number | null;
  stop_reason?: string | null;
  error?: string | null;
  session_key?: string | null;
}

export interface RuntimeControlResult {
  agent_id: string;
  changed: boolean;
  running: boolean;
  message: string;
}

export interface RuntimeSubagentStartBody {
  task: string;
  label?: string | null;
  parent_agent_id?: string | null;
  team_id?: string | null;
  origin_channel?: string | null;
  origin_chat_id?: string | null;
  session_key?: string | null;
}
