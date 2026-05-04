// Runtime agent management types (matches backend ``console.server.models.agent_runtime``).

/**
 * - `main`: primary agent loop
 * - `sub`: managed subagent task
 * - `agent`: enabled persisted persona running its own standalone loop
 * - `profile`: persisted persona profile not currently running (idle row)
 */
export type RuntimeAgentRole = 'main' | 'sub' | 'agent' | 'profile';

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
  /** Sub-agent's own transcript key (``subagent:<parent>:<task_id>``). */
  session_key?: string | null;
  /** Original parent session key the sub-agent was spawned from. */
  parent_session_key?: string | null;
  profile_id?: string | null;
  /** When true and ``role === 'agent'``, this row duplicates the gateway loop listing (omit redundant ``main`` row). */
  represents_gateway?: boolean;
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
  profile_id?: string | null;
}
