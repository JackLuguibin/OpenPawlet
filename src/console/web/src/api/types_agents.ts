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
}

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
