// Type definitions for the API

/** 消息来源：用户、主 Agent、子 Agent、工具调用。聊天区仅展示 user 与 main_agent。 */
export type MessageSource = 'user' | 'main_agent' | 'sub_agent' | 'tool_call';

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  timestamp?: string;
  /** 区分用户/主Agent/子Agent/工具调用；缺失时按 role 推断（兼容旧数据） */
  source?: MessageSource;
}

export interface ChatRequest {
  session_key?: string;
  message: string;
  stream?: boolean;
  bot_id?: string;
}

export interface BotInfo {
  id: string;
  name: string;
  config_path: string;
  workspace_path: string;
  created_at: string;
  updated_at: string;
  is_default: boolean;
  running: boolean;
}

export interface ChatResponse {
  session_key: string;
  message: string;
  tool_calls?: ToolCall[];
  done: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** OpenAI-style top-level `type`, e.g. `"function"`. */
  tool_call_type?: string;
  /** Filled from a later `role: tool` message with matching `tool_call_id`. */
  result?: string;
}

export interface SessionInfo {
  key: string;
  title?: string;
  message_count: number;
  last_message?: string;
  created_at?: string;
  updated_at?: string;
}

export interface ChannelStatus {
  name: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'error';
  stats: Record<string, unknown>;
}

export interface MCPStatus {
  name: string;
  status: 'connected' | 'disconnected' | 'error';
  server_type: 'stdio' | 'http';
  last_connected?: string;
  error?: string;
}

export interface ToolCallLog {
  id: string;
  tool_name: string;
  arguments: Record<string, unknown>;
  result?: string;
  status: 'success' | 'error';
  duration_ms: number;
  timestamp: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 按模型分别的使用量 */
  by_model?: Record<string, { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>;
  /** 当日成本（美元） */
  cost_usd?: number;
  /** 按模型分别的成本 */
  cost_by_model?: Record<string, number>;
}

export interface UsageHistoryItem {
  date: string;
  total_tokens: number;
  prompt_tokens: number;
  completion_tokens: number;
  /** 按模型分别的使用量 */
  by_model?: Record<string, { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>;
  /** 当日成本（美元） */
  cost_usd?: number;
  /** 按模型分别的成本 */
  cost_by_model?: Record<string, number>;
}

export interface Alert {
  id: string;
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  bot_id?: string;
  created_at_ms: number;
  dismissed: boolean;
  metadata?: Record<string, unknown>;
}

export interface HealthIssue {
  type: string;
  severity: 'critical' | 'warning' | 'info';
  message: string;
  bot_id?: string;
  path?: string;
  metadata?: Record<string, unknown>;
}

export interface StatusResponse {
  running: boolean;
  uptime_seconds: number;
  model?: string;
  active_sessions: number;
  messages_today: number;
  token_usage?: TokenUsage;
  channels: ChannelStatus[];
  mcp_servers: MCPStatus[];
}

export interface ConfigSection {
  general?: GeneralConfig;
  providers?: Record<string, ProviderConfig>;
  tools?: ToolsConfig;
  channels?: Record<string, ChannelConfig>;
  skills?: Record<string, SkillConfig>;
}

export interface GeneralConfig {
  workspace?: string;
  model?: string;
  max_iterations?: number;
  temperature?: number;
  reasoning_effort?: string;
}

export interface ProviderConfig {
  apiKey?: string;
  apiBase?: string;
  [key: string]: unknown;
}

export interface ToolsConfig {
  restrictToWorkspace?: boolean;
  mcpServers?: Record<string, MCPServerConfig>;
}

export interface MCPServerConfig {
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  toolTimeout?: number;
}

export interface ChannelConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SkillConfig {
  enabled?: boolean;
}

export interface SkillInfo {
  name: string;
  source: 'builtin' | 'workspace';
  description: string;
  enabled: boolean;
  path?: string;
  available?: boolean;
}

export type WSMessageType =
  | 'chat_token'
  | 'chat_done'
  | 'chat_start'
  /** One streaming segment ended (nanobot `stream_end`); not the full assistant turn. */
  | 'stream_frame_end'
  | 'session_key'
  | 'tool_call'
  | 'tool_result'
  | 'tool_progress'
  | 'error'
  | 'status_update'
  | 'sessions_update'
  | 'bots_update'
  | 'activity_update'
  | 'subagent_start'
  | 'subagent_done'
  | 'assistant_message'
  /** nanobot `event: message` — status / retry lines until `chat_end` */
  | 'channel_notice'
  /** nanobot `event: message` with empty `text` and JSON status in `data` (legacy `/status_json`) */
  | 'nanobot_status_json';

export interface WSMessage {
  type: WSMessageType;
  data: unknown;
  session_key?: string;
  /** Present on `activity_update` push messages. */
  entry?: ActivityItem;
}

// Streaming response types
export interface StreamChunk {
  type: WSMessageType;
  content?: string;
  session_key?: string;
  tool_call?: ToolCall;
  /** 与 HTTP ChatResponse 一致：一次回复中的多段工具调用（如 nanobot WebSocket 帧内嵌） */
  tool_calls?: ToolCall[];
  /** 模型在发起工具调用前的推理/说明，用于在 UI 中作为调用原因展示 */
  reasoning_content?: string;
  /** When true, append `reasoning_content` to the current streaming reasoning (nanobot `event: reasoning`). */
  reasoning_append?: boolean;
  tool_name?: string;
  tool_result?: string;
  error?: string;
  done?: boolean;
  /** 消息来源，用于 chat_done / assistant_message */
  source?: MessageSource;
  /** nanobot `stream_end` / `delta` optional stream segment id (same id within one streamed segment). */
  stream_id?: unknown;
  // Subagent event fields
  subagent_id?: string;
  label?: string;
  task?: string;
  result?: string;
  status?: 'ok' | 'error';
}

// Batch operations
export interface BatchDeleteRequest {
  keys: string[];
}

export interface BatchDeleteResponse {
  deleted: string[];
  failed: { key: string; error: string }[];
}

// Activity feed
export interface ActivityItem {
  id: string;
  type: 'message' | 'tool_call' | 'channel' | 'session' | 'error' | string;
  title: string;
  description?: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

// Channel refresh result
export interface ChannelRefreshResult {
  name: string;
  success: boolean;
  message?: string;
}

// MCP test result
export interface MCPTestResult {
  name: string;
  success: boolean;
  message?: string;
  latency_ms?: number;
}

// Extended session with preview
export interface SessionDetail extends SessionInfo {
  preview_messages?: Message[];
}

// Memory
export interface MemoryResponse {
  long_term: string;
  history: string;
}

// Cron
export type CronScheduleKind = 'at' | 'every' | 'cron';

export interface CronSchedule {
  kind: CronScheduleKind;
  at_ms?: number | null;
  every_ms?: number | null;
  expr?: string | null;
  tz?: string | null;
}

export interface CronJobState {
  next_run_at_ms?: number | null;
  last_run_at_ms?: number | null;
  last_status?: 'ok' | 'error' | 'skipped' | null;
  last_error?: string | null;
}

export interface CronPayload {
  kind: string;
  message: string;
  deliver?: boolean;
  channel?: string | null;
  to?: string | null;
}

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  state: CronJobState;
  created_at_ms: number;
  updated_at_ms: number;
  delete_after_run: boolean;
}

export interface CronAddRequest {
  name: string;
  schedule: CronSchedule;
  message?: string;
  deliver?: boolean;
  channel?: string | null;
  to?: string | null;
  delete_after_run?: boolean;
}

export interface CronStatus {
  enabled: boolean;
  jobs: number;
  next_wake_at_ms: number | null;
}

// Bot profile files (SOUL, USER, HEARTBEAT, TOOLS, AGENTS)
export interface BotFilesResponse {
  soul: string;
  user: string;
  heartbeat: string;
  tools: string;
  agents: string;
}
