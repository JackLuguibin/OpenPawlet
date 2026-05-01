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
  /**
   * UUID identifying the entire assistant reply for one user turn.
   * Stamped by the agent runtime on every transcript line and WebSocket frame
   * so the UI can group multi-iteration replies into one bubble.
   */
  reply_group_id?: string;
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
  team_id?: string | null;
  room_id?: string | null;
  agent_id?: string | null;
  /** True when the session_key follows ``subagent:<parent>:<task_id>``. */
  is_subagent?: boolean;
  subagent_task_id?: string | null;
  parent_session_key?: string | null;
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

export interface RuntimeLogChunk {
  source: 'console';
  path: string;
  text: string;
  exists: boolean;
  truncated: boolean;
  has_more: boolean;
  next_cursor?: string | null;
}

export interface RuntimeLogsData {
  chunks: RuntimeLogChunk[];
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

/** GET /observability — console API + OpenPawlet gateway /health probe */
export interface ConsoleObservabilityInfo {
  status: string;
  version: string;
}

export interface OpenPawletGatewayObservability {
  endpoint: string;
  ok: boolean;
  status?: string | null;
  version?: string | null;
  uptime_s?: number | null;
  error?: string | null;
}

export interface ObservabilityResponse {
  console: ConsoleObservabilityInfo;
  openpawlet_gateway: OpenPawletGatewayObservability;
}

/** GET /observability/timeline — run / LLM / tool events from OpenPawlet JSONL under workspace */
export interface AgentObservabilityEvent {
  ts: number;
  event: string;
  trace_id?: string | null;
  session_key?: string | null;
  payload: Record<string, unknown>;
}

export interface AgentObservabilityTimeline {
  ok: boolean;
  source_endpoint: string;
  error?: string | null;
  events: AgentObservabilityEvent[];
}

export interface StatusResponse {
  running: boolean;
  uptime_seconds: number;
  model?: string;
  active_sessions: number;
  messages_today: number;
  token_usage?: TokenUsage;
  /** Cumulative tokens per model (all logged history), for charts; today-only detail stays in token_usage. */
  model_token_totals?: Record<string, { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }>;
  channels: ChannelStatus[];
  mcp_servers: MCPStatus[];
}

/**
 * `agents.defaults` as returned by GET `/config` (`Config.model_dump(mode="json", by_alias=True)`).
 * Mirrors `openpawlet.config.schema.AgentDefaults` JSON keys (camelCase aliases).
 */
export interface AgentDefaultsJson {
  workspace?: string;
  model?: string;
  provider?: string;
  maxTokens?: number;
  contextWindowTokens?: number;
  contextBlockLimit?: number | null;
  temperature?: number;
  maxToolIterations?: number;
  maxHistoryMessages?: number;
  maxToolResultChars?: number;
  providerRetryMode?: string;
  reasoningEffort?: string | null;
  timezone?: string;
  unifiedSession?: boolean;
  disabledSkills?: string[];
  idleCompactAfterMinutes?: number;
  consolidationRatio?: number;
  persistSessionTranscript?: boolean;
  transcriptIncludeFullToolResults?: boolean;
  dream?: DreamConfigJson;
  /** Hand-edited ``config.json`` may use snake_case keys (pydantic ``populate_by_name``). */
  [key: string]: unknown;
}

/** Nested ``agents.defaults.dream`` — mirrors ``openpawlet.config.schema.DreamConfig`` JSON. */
export interface DreamConfigJson {
  intervalH?: number;
  modelOverride?: string | null;
  maxBatchSize?: number;
  maxIterations?: number;
  annotateLineAges?: boolean;
}

export interface AgentsConfigJson {
  defaults?: AgentDefaultsJson;
}

/** Settings General tab + Tools restrict row — camelCase keys aligned with ``AgentDefaultsJson``. */
export interface SettingsGeneralToolsFormValues {
  workspace: string;
  model: string;
  provider: string;
  timezone: string;
  maxTokens: number;
  contextWindowTokens: number;
  maxToolIterations: number;
  maxHistoryMessages: number;
  temperature: number;
  reasoningEffort: string;
  restrictToWorkspace: boolean;
  providerRetryMode: 'standard' | 'persistent';
  maxToolResultChars: number;
  contextBlockLimit: number | null;
  unifiedSession: boolean;
  idleCompactAfterMinutes: number;
  consolidationRatio: number;
  persistSessionTranscript: boolean;
  transcriptIncludeFullToolResults: boolean;
  disabledSkills: string[];
  dream: {
    intervalH: number;
    maxBatchSize: number;
    maxIterations: number;
    annotateLineAges: boolean;
    modelOverride: string;
  };
  /** Mirrors ``config.tools.web`` for Settings → Tools tab. */
  toolWeb: {
    enable: boolean;
    proxy: string;
    search: {
      provider: string;
      apiKey: string;
      baseUrl: string;
      maxResults: number;
      timeout: number;
    };
  };
  /** Mirrors ``config.tools.exec``. */
  toolExec: {
    enable: boolean;
    timeout: number;
    pathAppend: string;
    sandbox: string;
    allowedEnvKeys: string[];
  };
  /** Mirrors ``config.tools.my``. */
  toolMy: {
    enable: boolean;
    allowSet: boolean;
  };
  /** Mirrors ``config.tools.ssrfWhitelist``. */
  toolSsrfWhitelist: string[];
  /** ``channels`` root defaults — mirrors ``ChannelsConfig`` scalar fields (not per-plugin blocks). */
  channelsDefaults: {
    sendProgress: boolean;
    sendToolHints: boolean;
    sendToolEvents: boolean;
    sendReasoningContent: boolean;
    sendMaxRetries: number;
    transcriptionProvider: string;
    transcriptionLanguage: string;
    sessionTurnLifecycleChannels: string[];
  };
}

/**
 * ``channels`` root section — mirrors ``openpawlet.config.schema.ChannelsConfig`` (``extra="allow"``
 * adds built-in/plugin channel blocks as extra keys).
 */
export interface ChannelsConfigJson {
  sendProgress?: boolean;
  sendToolHints?: boolean;
  sendToolEvents?: boolean;
  sendReasoningContent?: boolean;
  sendMaxRetries?: number;
  transcriptionProvider?: string;
  transcriptionLanguage?: string | null;
  sessionTurnLifecycleChannels?: string[];
  [key: string]: unknown;
}

/** Single LLM provider block under ``providers.<name>``. */
export interface ProviderConfigJson {
  apiKey?: string | null;
  apiBase?: string | null;
  extraHeaders?: Record<string, string> | null;
}

export type ProvidersConfigJson = Record<string, ProviderConfigJson>;

/** ``api`` root section — ``openpawlet.config.schema.ApiConfig``. */
export interface ApiConfigJson {
  host?: string;
  port?: number;
  timeout?: number;
}

/** ``gateway.heartbeat`` — ``openpawlet.config.schema.HeartbeatConfig``. */
export interface HeartbeatConfigJson {
  enabled?: boolean;
  intervalS?: number;
  keepRecentMessages?: number;
}

/** ``gateway`` root section — ``openpawlet.config.schema.GatewayConfig``. */
export interface GatewayConfigJson {
  host?: string;
  port?: number;
  heartbeat?: HeartbeatConfigJson;
}

/** ``tools.web.search`` — ``openpawlet.config.schema.WebSearchConfig``. */
export interface WebSearchConfigJson {
  provider?: string;
  apiKey?: string;
  baseUrl?: string;
  maxResults?: number;
  timeout?: number;
}

/** ``tools.web.fetch`` — ``openpawlet.config.schema.WebFetchConfig``. */
export interface WebFetchConfigJson {
  useJinaReader?: boolean;
}

/** ``tools.web`` — ``openpawlet.config.schema.WebToolsConfig``. */
export interface WebToolsConfigJson {
  enable?: boolean;
  proxy?: string | null;
  userAgent?: string | null;
  search?: WebSearchConfigJson;
  fetch?: WebFetchConfigJson;
}

/** ``tools.exec`` — ``openpawlet.config.schema.ExecToolConfig``. */
export interface ExecToolConfigJson {
  enable?: boolean;
  timeout?: number;
  pathAppend?: string;
  sandbox?: string;
  allowedEnvKeys?: string[];
}

/** ``tools.my`` — ``openpawlet.config.schema.MyToolConfig``. */
export interface MyToolConfigJson {
  enable?: boolean;
  allowSet?: boolean;
}

/** ``tools`` root section — ``openpawlet.config.schema.ToolsConfig``. */
export interface ToolsConfig {
  web?: WebToolsConfigJson;
  exec?: ExecToolConfigJson;
  my?: MyToolConfigJson;
  restrictToWorkspace?: boolean;
  /** @deprecated Hand-edited JSON; canonical key is ``restrictToWorkspace``. */
  restrict_to_workspace?: boolean;
  mcpServers?: Record<string, MCPServerConfig>;
  /** Legacy snake_case in hand-edited ``config.json``; prefer ``mcpServers``. */
  mcp_servers?: Record<string, MCPServerConfig>;
  ssrfWhitelist?: string[];
}

/** Single MCP server entry — ``openpawlet.config.schema.MCPServerConfig``. */
export interface MCPServerConfig {
  type?: 'stdio' | 'sse' | 'streamableHttp' | null;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  toolTimeout?: number;
  enabledTools?: string[];
}

/** Skill bundle toggles from extras / merged ``skills`` map (shape varies). */
export interface SkillConfig {
  enabled?: boolean;
}

/**
 * GET ``/config`` payload: validated core (``openpawlet.config.schema.Config`` dump ``by_alias``)
 * merged with extra top-level keys from disk (e.g. ``skills``, non-core blobs).
 */
export interface ConfigSection {
  agents?: AgentsConfigJson;
  channels?: ChannelsConfigJson;
  providers?: ProvidersConfigJson;
  api?: ApiConfigJson;
  gateway?: GatewayConfigJson;
  tools?: ToolsConfig;
  /** Console skill bundles / extras from ``config.json``. */
  skills?: Record<string, SkillConfig>;
  /** Serialized key ``skillsGit`` (see ``Config.skills_git``). */
  skillsGit?: Record<string, unknown>;
}

/** @deprecated OpenPawlet console config has no ``general`` section; use ``agents.defaults``. */
export interface GeneralConfig {
  workspace?: string;
  model?: string;
  max_iterations?: number;
  temperature?: number;
  reasoning_effort?: string;
}

/** @deprecated Use ProviderConfigJson — alias kept for gradual migration. */
export type ProviderConfig = ProviderConfigJson;

/** @deprecated Prefer ChannelsConfigJson — per-channel plugin shapes vary. */
export interface ChannelConfig {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface SkillInfo {
  name: string;
  source: 'builtin' | 'workspace';
  description: string;
  enabled: boolean;
  path?: string;
  available?: boolean;
}

// ====================
// Skills Git source repos
// ====================

export type SkillsGitRepoKind = 'single' | 'multi';
export type SkillsGitAuthKind = 'none' | 'token' | 'ssh';

export interface SkillsGitAuth {
  kind: SkillsGitAuthKind;
  token_env?: string | null;
  username?: string | null;
  ssh_key_path?: string | null;
  ssh_passphrase_env?: string | null;
}

export interface SkillsGitRepo {
  id: string;
  name: string;
  url: string;
  branch?: string | null;
  kind: SkillsGitRepoKind;
  target?: string | null;
  auth: SkillsGitAuth;
  auto_update: boolean;
  interval_minutes: number;
  last_sync_at?: string | null;
  last_sync_status?: 'ok' | 'error' | 'pending' | null;
  last_sync_message?: string | null;
  last_commit_sha?: string | null;
}

export interface SkillsGitRepoUpsertBody {
  name: string;
  url: string;
  branch?: string | null;
  kind: SkillsGitRepoKind;
  target?: string | null;
  auth: SkillsGitAuth;
  auto_update: boolean;
  interval_minutes: number;
}

export interface SkillsGitSyncResult {
  id: string;
  name: string;
  status: 'ok' | 'error';
  message: string;
  commit_sha?: string | null;
  synced_skills: string[];
  duration_ms?: number | null;
}

export type WSMessageType =
  | 'chat_token'
  | 'chat_done'
  | 'chat_start'
  /** One streaming segment ended (OpenPawlet `event: stream_end`); not the full assistant turn. */
  | 'stream_end'
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
  /** OpenPawlet `event: message` — status / retry lines until `chat_end` */
  | 'channel_notice'
  /** Native `event: status` (`openpawlet_status_payload`) or legacy `message`+`content` (`/status-json`) */
  | 'status'
  /** Welcome frame from `/ws/state` after the upgrade settles. */
  | 'welcome'
  /** Server-side keepalive ping; SPA replies are not required. */
  | 'ping'
  /** Reply to a client-issued `ping`. */
  | 'pong'
  /** A single transcript message was appended (replaces transcript polling). */
  | 'session_message_appended'
  /** A session JSONL was deleted on disk. */
  | 'session_deleted'
  /** Channel list snapshot changed (config save / channel toggle). */
  | 'channels_update'
  /** MCP server list snapshot changed. */
  | 'mcp_update'
  /** Multi-agent registry was mutated (create/update/delete). */
  | 'agents_update'
  /** Runtime agent loop status table snapshot. */
  | 'runtime_agents_update'
  /** A single observability JSONL row was appended. */
  | 'observability_event';

export interface WSMessage {
  type: WSMessageType;
  data: unknown;
  session_key?: string;
  /** Present on `activity_update` push messages. */
  entry?: ActivityItem;
  /** Server-side wall-clock timestamp; set by ``state_hub.publish``. */
  server_ts?: number;
}

// Streaming response types
export interface StreamChunk {
  type: WSMessageType;
  content?: string;
  session_key?: string;
  tool_call?: ToolCall;
  /** 与 HTTP ChatResponse 一致：一次回复中的多段工具调用（如 OpenPawlet WebSocket 帧内嵌） */
  tool_calls?: ToolCall[];
  /** 模型在发起工具调用前的推理/说明，用于在 UI 中作为调用原因展示 */
  reasoning_content?: string;
  /** When true, append `reasoning_content` to the current streaming reasoning (OpenPawlet `event: reasoning`). */
  reasoning_append?: boolean;
  tool_name?: string;
  tool_result?: string;
  error?: string;
  done?: boolean;
  /** 消息来源，用于 chat_done / assistant_message */
  source?: MessageSource;
  /** OpenPawlet `stream_end` / `delta` optional stream segment id (same id within one streamed segment). */
  stream_id?: unknown;
  // Subagent event fields
  subagent_id?: string;
  label?: string;
  task?: string;
  result?: string;
  status?: 'ok' | 'error';
  /**
   * UUID identifying the entire assistant reply for one user turn (server-issued).
   * Present on every OpenPawlet WebSocket frame for the turn so the chat UI can
   * group streamed deltas / tool events / final answer into one bubble.
   */
  reply_group_id?: string;
  /**
   * Native OpenPawlet `event: status` body (`data` field), when mapped without
   * stringifying — avoids JSON parse for `/status-json` replies.
   */
  openpawlet_status_payload?: Record<string, unknown>;
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

export interface ActivityFeedPage {
  items: ActivityItem[];
  has_more?: boolean;
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

export interface CronUpdateRequest {
  name?: string;
  schedule?: CronSchedule;
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

/** Per-execution record returned by ``GET /cron/history``. */
export interface CronHistoryRun {
  run_at_ms: number;
  status: 'ok' | 'error' | 'skipped' | string;
  duration_ms: number;
  error?: string | null;
  job_id: string;
  job_name: string;
  agent_id?: string | null;
  skills: string[];
  mcp_servers: string[];
  tools: string[];
  prompt: string;
  deliver?: boolean | null;
  channel?: string | null;
  to?: string | null;
}

// Bot profile files (SOUL, USER, HEARTBEAT, TOOLS, AGENTS)
export interface BotFilesResponse {
  soul: string;
  user: string;
  heartbeat: string;
  tools: string;
  agents: string;
}
