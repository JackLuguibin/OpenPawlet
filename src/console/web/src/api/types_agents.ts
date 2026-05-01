import type { Alert, HealthIssue, BotInfo, BotFilesResponse, ChatRequest, ChatResponse, ChannelStatus, ConfigSection, CronAddRequest, CronJob, CronStatus, MCPStatus, MemoryResponse, SessionInfo, SessionDetail, StatusResponse, ToolCallLog, StreamChunk, BatchDeleteResponse, ActivityItem, ChannelRefreshResult, MCPTestResult } from './types';

// ====================
// Agent Types
// ====================

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
  temperature: number | null;
  system_prompt: string | null;
  skills: string[];
  topics: string[];
  collaborators: string[];
  enabled: boolean;
  created_at: string;
  team_ids?: string[];
  // Independent persona overrides (null = inherit from main agent).
  max_tokens?: number | null;
  max_tool_iterations?: number | null;
  max_tool_result_chars?: number | null;
  context_window_tokens?: number | null;
  reasoning_effort?: string | null;
  timezone?: string | null;
  web_enabled?: boolean | null;
  exec_enabled?: boolean | null;
  mcp_servers_allowlist?: string[] | null;
  allowed_tools?: string[] | null;
  skills_denylist?: string[];
  use_own_bootstrap?: boolean;
  inherit_main_bootstrap?: boolean;
  /**
   * Bind this agent to one configured LLM provider instance (see
   * llm_providers.json). Takes precedence over the bare ``model`` field
   * for routing.
   */
  provider_instance_id?: string | null;
  // Read-only (server-stamped) flags reflecting on-disk bootstrap files.
  has_soul?: boolean;
  has_user?: boolean;
  has_agents_md?: boolean;
  has_tools_md?: boolean;
  /** True for the synthetic primary gateway row from GET /agents (not on disk). */
  is_main?: boolean;
}

export interface AgentCreateRequest {
  id?: string;
  name: string;
  description?: string | null;
  model?: string | null;
  temperature?: number | null;
  system_prompt?: string | null;
  skills?: string[];
  topics?: string[];
  collaborators?: string[];
  enabled?: boolean;
  max_tokens?: number | null;
  max_tool_iterations?: number | null;
  max_tool_result_chars?: number | null;
  context_window_tokens?: number | null;
  reasoning_effort?: string | null;
  timezone?: string | null;
  web_enabled?: boolean | null;
  exec_enabled?: boolean | null;
  mcp_servers_allowlist?: string[] | null;
  allowed_tools?: string[] | null;
  skills_denylist?: string[] | null;
  use_own_bootstrap?: boolean | null;
  inherit_main_bootstrap?: boolean | null;
  provider_instance_id?: string | null;
}

export interface AgentUpdateRequest {
  name?: string;
  description?: string | null;
  model?: string | null;
  temperature?: number | null;
  system_prompt?: string | null;
  skills?: string[];
  topics?: string[];
  collaborators?: string[];
  enabled?: boolean;
  max_tokens?: number | null;
  max_tool_iterations?: number | null;
  max_tool_result_chars?: number | null;
  context_window_tokens?: number | null;
  reasoning_effort?: string | null;
  timezone?: string | null;
  web_enabled?: boolean | null;
  exec_enabled?: boolean | null;
  mcp_servers_allowlist?: string[] | null;
  allowed_tools?: string[] | null;
  skills_denylist?: string[] | null;
  use_own_bootstrap?: boolean | null;
  inherit_main_bootstrap?: boolean | null;
  provider_instance_id?: string | null;
}

export interface AgentBootstrapFiles {
  soul: string;
  user: string;
  agents: string;
  tools: string;
}

export interface AgentBootstrapUpdateBody {
  content: string;
}

export type AgentBootstrapKey = 'soul' | 'user' | 'agents' | 'tools';

export interface AgentStatus {
  agent_id: string;
  agent_name: string;
  enabled: boolean;
  total_agents: number;
  enabled_agents: number;
  subscribed_agents: string[];
  zmq_initialized: boolean;
  current_agent_id: string | null;
}

export interface AgentsSystemStatus {
  total_agents: number;
  enabled_agents: number;
  subscribed_agents: string[];
  zmq_initialized: boolean;
  current_agent_id: string | null;
}

export interface ModelsResponse {
  default_model: string | null;
  available_models: string[];
}

export interface SkillInfo {
  name: string;
  description: string;
}

export interface SkillsResponse {
  skills: SkillInfo[];
}

export type {
  Alert,
  HealthIssue,
  BotInfo,
  BotFilesResponse,
  ChatRequest,
  ChatResponse,
  ChannelStatus,
  ConfigSection,
  CronAddRequest,
  CronJob,
  CronStatus,
  MCPStatus,
  MemoryResponse,
  SessionInfo,
  SessionDetail,
  StatusResponse,
  ToolCallLog,
  StreamChunk,
  BatchDeleteResponse,
  ActivityItem,
  ChannelRefreshResult,
  MCPTestResult,
};
