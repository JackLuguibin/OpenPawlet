import type {
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
  SkillInfo,
  ToolCallLog,
  BatchDeleteResponse,
  ActivityItem,
  ChannelRefreshResult,
  MCPTestResult,
} from './types';

const API_BASE = '/api/v1';

function botQuery(botId?: string | null): string {
  return botId ? `?bot_id=${encodeURIComponent(botId)}` : '';
}

function appendBotQuery(url: string, botId?: string | null): string {
  if (!botId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}bot_id=${encodeURIComponent(botId)}`;
}

/** Extract a human-readable message from API error JSON bodies. */
function getErrorMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object') {
    return fallback;
  }
  const o = body as Record<string, unknown>;

  if (
    'error' in o &&
    o.error &&
    typeof o.error === 'object' &&
    typeof (o.error as { message?: unknown }).message === 'string'
  ) {
    return (o.error as { message: string }).message;
  }

  if ('detail' in o) {
    const d = o.detail;
    if (typeof d === 'string') return d;
    if (Array.isArray(d) && d.length) {
      return d
        .map((x) =>
          typeof x === 'object' && x && 'msg' in x
            ? String((x as { msg: unknown }).msg)
            : String(x)
        )
        .join('; ');
    }
  }

  if (typeof o.message === 'string') {
    return o.message;
  }

  return fallback;
}

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const contentType = response.headers.get('content-type') ?? '';
  const isJson = contentType.includes('application/json');

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    if (isJson) {
      try {
        const body = await response.json();
        message = getErrorMessage(body, message);
      } catch {
        // keep default message
      }
    }
    throw new Error(message);
  }

  const body = await response.json();

  // 统一成功信封：{ code: 0, message: "success", data } -> 返回 data
  if (body && typeof body === 'object' && 'code' in body && body.code === 0 && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

// ====================
// Bot Management API
// ====================

export async function listBots(): Promise<BotInfo[]> {
  return fetchJson<BotInfo[]>(`${API_BASE}/bots`);
}

export async function getBot(botId: string): Promise<BotInfo> {
  return fetchJson<BotInfo>(`${API_BASE}/bots/${encodeURIComponent(botId)}`);
}

export async function createBot(name: string, sourceConfig?: Record<string, unknown>): Promise<BotInfo> {
  return fetchJson<BotInfo>(`${API_BASE}/bots`, {
    method: 'POST',
    body: JSON.stringify({ name, source_config: sourceConfig }),
  });
}

export async function deleteBot(botId: string): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/bots/${encodeURIComponent(botId)}`, {
    method: 'DELETE',
  });
}

export async function setDefaultBot(botId: string): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/bots/default`, {
    method: 'PUT',
    body: JSON.stringify({ bot_id: botId }),
  });
}

export async function startBot(botId: string): Promise<BotInfo> {
  return fetchJson<BotInfo>(`${API_BASE}/bots/${encodeURIComponent(botId)}/start`, {
    method: 'POST',
  });
}

export async function stopBot(botId: string): Promise<BotInfo> {
  return fetchJson<BotInfo>(`${API_BASE}/bots/${encodeURIComponent(botId)}/stop`, {
    method: 'POST',
  });
}

// ====================
// Status API
// ====================

export async function getStatus(botId?: string | null): Promise<StatusResponse> {
  return fetchJson<StatusResponse>(`${API_BASE}/status${botQuery(botId)}`);
}

export async function getUsageHistory(
  botId?: string | null,
  days: number = 14
): Promise<import('./types').UsageHistoryItem[]> {
  const params = new URLSearchParams();
  if (botId) params.set('bot_id', botId);
  params.set('days', String(days));
  return fetchJson(`${API_BASE}/usage/history?${params}`);
}

export async function getChannels(botId?: string | null): Promise<ChannelStatus[]> {
  return fetchJson<ChannelStatus[]>(`${API_BASE}/channels${botQuery(botId)}`);
}

export async function updateChannel(
  name: string,
  data: Record<string, unknown>,
  botId?: string | null
): Promise<Record<string, unknown>> {
  return fetchJson<Record<string, unknown>>(
    appendBotQuery(`${API_BASE}/channels/${encodeURIComponent(name)}`, botId),
    {
      method: 'PUT',
      body: JSON.stringify({ data }),
    }
  );
}

export async function deleteChannel(
  name: string,
  botId?: string | null
): Promise<{ status: string }> {
  return fetchJson(appendBotQuery(`${API_BASE}/channels/${encodeURIComponent(name)}`, botId), {
    method: 'DELETE',
  });
}

export async function getMCPServers(botId?: string | null): Promise<MCPStatus[]> {
  return fetchJson<MCPStatus[]>(`${API_BASE}/mcp${botQuery(botId)}`);
}

export async function getAlerts(
  botId?: string | null,
  includeDismissed?: boolean
): Promise<Alert[]> {
  const params = new URLSearchParams();
  if (botId) params.set('bot_id', botId);
  if (includeDismissed) params.set('include_dismissed', 'true');
  return fetchJson<Alert[]>(`${API_BASE}/alerts?${params}`);
}

export async function dismissAlert(alertId: string, botId?: string | null): Promise<{ status: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/alerts/${encodeURIComponent(alertId)}/dismiss`, botId),
    { method: 'POST' }
  );
}

// ====================
// Sessions API
// ====================

export async function listSessions(botId?: string | null): Promise<SessionInfo[]> {
  return fetchJson<SessionInfo[]>(`${API_BASE}/sessions${botQuery(botId)}`);
}

export async function getSession(key: string, botId?: string | null): Promise<{
  key: string;
  title?: string;
  messages: unknown[];
  message_count: number;
}> {
  return fetchJson(appendBotQuery(`${API_BASE}/sessions/${encodeURIComponent(key)}`, botId));
}

export async function createSession(key?: string, botId?: string | null): Promise<SessionInfo> {
  return fetchJson<SessionInfo>(`${API_BASE}/sessions${botQuery(botId)}`, {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export async function deleteSession(key: string, botId?: string | null): Promise<{ status: string }> {
  return fetchJson(appendBotQuery(`${API_BASE}/sessions/${encodeURIComponent(key)}`, botId), {
    method: 'DELETE',
  });
}

// ====================
// Chat API
// ====================

export async function sendChatMessage(request: ChatRequest): Promise<ChatResponse> {
  return fetchJson<ChatResponse>(`${API_BASE}/chat`, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

// ====================
// Tools API
// ====================

export async function getToolLogs(
  limit = 50,
  toolName?: string,
  botId?: string | null
): Promise<ToolCallLog[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (toolName) params.append('tool_name', toolName);
  if (botId) params.append('bot_id', botId);
  return fetchJson<ToolCallLog[]>(`${API_BASE}/tools/log?${params}`);
}

// ====================
// Memory API
// ====================

export async function getMemory(botId?: string | null): Promise<MemoryResponse> {
  const raw = await fetchJson<
    MemoryResponse & { longTerm?: string }
  >(appendBotQuery(`${API_BASE}/memory`, botId));
  return {
    long_term: raw.long_term ?? raw.longTerm ?? '',
    history: raw.history ?? '',
  };
}

export async function getBotFiles(botId?: string | null): Promise<BotFilesResponse> {
  return fetchJson<BotFilesResponse>(appendBotQuery(`${API_BASE}/bot-files`, botId));
}

export async function updateBotFile(
  key: keyof BotFilesResponse,
  content: string,
  botId?: string | null
): Promise<{ status: string; key: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/bot-files/${encodeURIComponent(key)}`, botId),
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }
  );
}

// ====================
// Config API
// ====================

export async function getConfig(botId?: string | null): Promise<ConfigSection> {
  return fetchJson<ConfigSection>(`${API_BASE}/config${botQuery(botId)}`);
}

// ====================
// Skills API
// ====================

export async function listSkills(botId?: string | null): Promise<SkillInfo[]> {
  return fetchJson<SkillInfo[]>(`${API_BASE}/skills${botQuery(botId)}`);
}

export async function updateSkillsConfig(
  data: Record<string, { enabled?: boolean }>,
  botId?: string | null
): Promise<ConfigSection> {
  return updateConfig('skills', data, botId);
}

export async function getSkillContent(
  name: string,
  botId?: string | null
): Promise<{ name: string; content: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/${encodeURIComponent(name)}/content`, botId)
  );
}

export async function copySkillToWorkspace(
  name: string,
  botId?: string | null
): Promise<{ status: string; name: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/${encodeURIComponent(name)}/copy-to-workspace`, botId),
    { method: 'POST' }
  );
}

export async function updateSkillContent(
  name: string,
  content: string,
  botId?: string | null
): Promise<{ status: string; name: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/${encodeURIComponent(name)}/content`, botId),
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }
  );
}

export async function updateSkillBundle(
  name: string,
  data: {
    content: string;
    files?: Record<string, string>;
    directories?: string[];
    delete_rels?: string[];
  },
  botId?: string | null
): Promise<{ status: string; name: string }> {
  const payload: Record<string, unknown> = {
    content: data.content,
  };
  if (data.files && Object.keys(data.files).length > 0) {
    payload.files = data.files;
  }
  if (data.directories && data.directories.length > 0) {
    payload.directories = data.directories;
  }
  if (data.delete_rels && data.delete_rels.length > 0) {
    payload.delete_rels = data.delete_rels;
  }
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/${encodeURIComponent(name)}/bundle`, botId),
    {
      method: 'PUT',
      body: JSON.stringify(payload),
    }
  );
}

export async function createSkill(
  data: {
    name: string;
    description: string;
    content?: string;
    files?: Record<string, string>;
    directories?: string[];
  },
  botId?: string | null
): Promise<{ status: string; name: string }> {
  const payload: Record<string, unknown> = {
    name: data.name,
    description: data.description,
    content: data.content || '',
  };
  if (data.files && Object.keys(data.files).length > 0) {
    payload.files = data.files;
  }
  if (data.directories && data.directories.length > 0) {
    payload.directories = data.directories;
  }
  return fetchJson(`${API_BASE}/skills${botQuery(botId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function deleteSkill(
  name: string,
  botId?: string | null
): Promise<{ status: string; name: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/${encodeURIComponent(name)}`, botId),
    {
      method: 'DELETE',
    }
  );
}

export async function updateConfig(
  section: string,
  data: Record<string, unknown>,
  botId?: string | null
): Promise<ConfigSection> {
  return fetchJson<ConfigSection>(`${API_BASE}/config${botQuery(botId)}`, {
    method: 'PUT',
    body: JSON.stringify({ section, data }),
  });
}

export async function getConfigSchema(botId?: string | null): Promise<unknown> {
  return fetchJson(`${API_BASE}/config/schema${botQuery(botId)}`);
}

export async function validateConfig(
  data: Record<string, unknown>,
  botId?: string | null
): Promise<{ valid: boolean; errors: string[] }> {
  return fetchJson(`${API_BASE}/config/validate${botQuery(botId)}`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

// ====================
// Environment Variables API
// ====================

export async function getEnv(botId?: string | null): Promise<{ vars: Record<string, string> }> {
  return fetchJson<{ vars: Record<string, string> }>(`${API_BASE}/env${botQuery(botId)}`);
}

export async function updateEnv(
  vars: Record<string, string>,
  botId?: string | null
): Promise<{ status: string; vars?: Record<string, string> }> {
  return fetchJson(`${API_BASE}/env${botQuery(botId)}`, {
    method: 'PUT',
    body: JSON.stringify({ vars }),
  });
}

// ====================
// Cron API
// ====================

export async function listCronJobs(
  botId?: string | null,
  includeDisabled = false
): Promise<CronJob[]> {
  const params = new URLSearchParams();
  if (botId) params.set('bot_id', botId);
  if (includeDisabled) params.set('include_disabled', 'true');
  return fetchJson<CronJob[]>(`${API_BASE}/cron?${params}`);
}

export async function addCronJob(
  data: CronAddRequest,
  botId?: string | null
): Promise<CronJob> {
  return fetchJson<CronJob>(appendBotQuery(`${API_BASE}/cron`, botId), {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function removeCronJob(
  jobId: string,
  botId?: string | null
): Promise<{ status: string; job_id: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/cron/${encodeURIComponent(jobId)}`, botId),
    { method: 'DELETE' }
  );
}

export async function enableCronJob(
  jobId: string,
  enabled: boolean,
  botId?: string | null
): Promise<CronJob> {
  const params = new URLSearchParams({ enabled: String(enabled) });
  if (botId) params.set('bot_id', botId);
  return fetchJson<CronJob>(
    `${API_BASE}/cron/${encodeURIComponent(jobId)}/enable?${params}`,
    { method: 'PUT' }
  );
}

export async function runCronJob(
  jobId: string,
  force = false,
  botId?: string | null
): Promise<{ status: string; job_id: string }> {
  const params = new URLSearchParams({ force: String(force) });
  if (botId) params.set('bot_id', botId);
  return fetchJson(
    `${API_BASE}/cron/${encodeURIComponent(jobId)}/run?${params}`,
    { method: 'POST' }
  );
}

export async function getCronStatus(botId?: string | null): Promise<CronStatus> {
  return fetchJson<CronStatus>(appendBotQuery(`${API_BASE}/cron/status`, botId));
}

export async function getCronHistory(
  botId?: string | null,
  jobId?: string | null
): Promise<Record<string, Array<{ run_at_ms: number; status: string; duration_ms: number; error?: string }>>> {
  const params = new URLSearchParams();
  if (botId) params.set('bot_id', botId);
  if (jobId) params.set('job_id', jobId);
  return fetchJson(`${API_BASE}/cron/history?${params}`);
}

// ====================
// Control API
// ====================

export async function stopCurrentTask(botId?: string | null): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/control/stop${botQuery(botId)}`, { method: 'POST' });
}

export async function restartBot(botId?: string | null): Promise<{ status: string }> {
  return fetchJson(`${API_BASE}/control/restart${botQuery(botId)}`, { method: 'POST' });
}

// ====================
// Health Check
// ====================

export async function healthCheck(): Promise<{ status: string; version: string }> {
  return fetchJson(`${API_BASE}/health`);
}

export async function getHealthAudit(botId?: string | null): Promise<{ issues: HealthIssue[] }> {
  return fetchJson(`${API_BASE}/health/audit${botQuery(botId)}`);
}

// ====================
// Workspace API
// ====================

export async function listWorkspaceFiles(
  path?: string,
  depth?: number,
  botId?: string | null
): Promise<{ path: string; items: Array<{ name: string; path: string; is_dir: boolean; children?: unknown[] }> }> {
  const params = new URLSearchParams();
  if (path) params.set('path', path);
  if (depth != null) params.set('depth', String(depth));
  if (botId) params.set('bot_id', botId);
  return fetchJson(`${API_BASE}/workspace/files?${params}`);
}

export async function getWorkspaceFile(
  path: string,
  botId?: string | null
): Promise<{ path: string; content: string }> {
  const params = new URLSearchParams({ path });
  if (botId) params.set('bot_id', botId);
  return fetchJson(`${API_BASE}/workspace/file?${params}`);
}

export async function searchSkillsRegistry(
  query?: string,
  registryUrl?: string,
  botId?: string | null
): Promise<Array<{ name: string; description?: string; url?: string; version?: string }>> {
  const params = new URLSearchParams();
  if (query) params.set('q', query);
  if (registryUrl) params.set('registry_url', registryUrl);
  if (botId) params.set('bot_id', botId);
  return fetchJson(`${API_BASE}/skills/registry/search?${params}`);
}

export async function installSkillFromRegistry(
  name: string,
  botId?: string | null,
  registryUrl?: string
): Promise<{ status: string; name: string }> {
  return fetchJson(appendBotQuery(`${API_BASE}/skills/install-from-registry`, botId), {
    method: 'POST',
    body: JSON.stringify({ name, registry_url: registryUrl || undefined }),
  });
}

export async function updateWorkspaceFile(
  path: string,
  content: string,
  botId?: string | null
): Promise<{ status: string; path: string }> {
  return fetchJson(appendBotQuery(`${API_BASE}/workspace/file`, botId), {
    method: 'PUT',
    body: JSON.stringify({ path, content }),
  });
}
// ====================
// Batch Operations
// ====================

export async function deleteSessionsBatch(
  keys: string[],
  botId?: string | null
): Promise<BatchDeleteResponse> {
  return fetchJson<BatchDeleteResponse>(`${API_BASE}/sessions/batch${botQuery(botId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ keys }),
  });
}

// ====================
// Activity Feed
// ====================

export async function getRecentActivity(
  limit = 20,
  botId?: string | null,
  activityType?: string
): Promise<ActivityItem[]> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (botId) params.append('bot_id', botId);
  if (activityType) params.append('activity_type', activityType);
  return fetchJson<ActivityItem[]>(`${API_BASE}/activity?${params}`);
}

// ====================
// Channel Operations
// ====================

export async function refreshChannel(
  name: string,
  botId?: string | null
): Promise<ChannelRefreshResult> {
  return fetchJson<ChannelRefreshResult>(appendBotQuery(`${API_BASE}/channels/${name}/refresh`, botId), {
    method: 'POST',
  });
}

export async function refreshAllChannels(botId?: string | null): Promise<ChannelRefreshResult[]> {
  return fetchJson<ChannelRefreshResult[]>(`${API_BASE}/channels/refresh${botQuery(botId)}`, {
    method: 'POST',
  });
}

// ====================
// MCP Operations
// ====================

export async function testMCPConnection(name: string, botId?: string | null): Promise<MCPTestResult> {
  return fetchJson<MCPTestResult>(appendBotQuery(`${API_BASE}/mcp/${name}/test`, botId), {
    method: 'POST',
  });
}

export async function refreshMCPServer(name: string, botId?: string | null): Promise<MCPTestResult> {
  return fetchJson<MCPTestResult>(appendBotQuery(`${API_BASE}/mcp/${name}/refresh`, botId), {
    method: 'POST',
  });
}

// ====================
// Session Detail
// ====================

export async function getSessionDetail(key: string, botId?: string | null): Promise<SessionDetail> {
  return fetchJson<SessionDetail>(
    appendBotQuery(`${API_BASE}/sessions/${encodeURIComponent(key)}?detail=true`, botId)
  );
}

// ====================
// Agent Management API
// ====================

export async function listAgents(botId: string): Promise<import('./types_agents').Agent[]> {
  return fetchJson<import('./types_agents').Agent[]>(`${API_BASE}/bots/${encodeURIComponent(botId)}/agents`);
}

export async function getAgent(botId: string, agentId: string): Promise<import('./types_agents').Agent> {
  return fetchJson<import('./types_agents').Agent>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}`
  );
}

export async function createAgent(botId: string, data: import('./types_agents').AgentCreateRequest): Promise<import('./types_agents').Agent> {
  return fetchJson<import('./types_agents').Agent>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents`,
    {
      method: 'POST',
      body: JSON.stringify(data),
    }
  );
}

export async function updateAgent(
  botId: string,
  agentId: string,
  data: import('./types_agents').AgentUpdateRequest
): Promise<import('./types_agents').Agent> {
  return fetchJson<import('./types_agents').Agent>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
}

export async function deleteAgent(botId: string, agentId: string): Promise<{ status: string; agent_id: string }> {
  return fetchJson<{ status: string; agent_id: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}`,
    {
      method: 'DELETE',
    }
  );
}

export async function enableAgent(botId: string, agentId: string): Promise<import('./types_agents').Agent> {
  return fetchJson<import('./types_agents').Agent>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/enable`,
    {
      method: 'POST',
    }
  );
}

export async function disableAgent(botId: string, agentId: string): Promise<import('./types_agents').Agent> {
  return fetchJson<import('./types_agents').Agent>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/disable`,
    {
      method: 'POST',
    }
  );
}

export async function getAgentStatus(botId: string, agentId: string): Promise<import('./types_agents').AgentStatus> {
  return fetchJson<import('./types_agents').AgentStatus>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/status`
  );
}

export async function getAgentsSystemStatus(botId: string): Promise<import('./types_agents').AgentsSystemStatus> {
  return fetchJson<import('./types_agents').AgentsSystemStatus>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/system-status/status`
  );
}

// ====================
// Category API
// ====================

export interface CategoryInfo {
  key: string;
  label: string;
  color: string;
}

export async function listCategories(botId: string): Promise<CategoryInfo[]> {
  return fetchJson<CategoryInfo[]>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/categories`
  );
}

export async function addCategory(botId: string, label: string): Promise<CategoryInfo> {
  return fetchJson<CategoryInfo>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/categories`,
    {
      method: 'POST',
      body: JSON.stringify({ label }),
    }
  );
}

export async function removeCategory(botId: string, key: string): Promise<{ status: string; key: string }> {
  return fetchJson<{ status: string; key: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/categories/${encodeURIComponent(key)}`,
    { method: 'DELETE' }
  );
}

export async function getCategoryOverrides(botId: string): Promise<Record<string, string>> {
  return fetchJson<Record<string, string>>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/categories/overrides`
  );
}

export async function setCategoryOverride(
  botId: string,
  agentId: string,
  categoryKey: string | null
): Promise<Record<string, string>> {
  return fetchJson<Record<string, string>>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/categories/overrides`,
    {
      method: 'PUT',
      body: JSON.stringify({ agent_id: agentId, category_key: categoryKey }),
    }
  );
}


export interface DelegateTaskRequest {
  to_agent_id: string;
  task: string;
  context?: Record<string, unknown>;
  wait_response?: boolean;
}

export interface DelegateTaskResponse {
  correlation_id: string;
  response: string | null;
}

export async function delegateTask(
  botId: string,
  fromAgentId: string,
  request: DelegateTaskRequest
): Promise<DelegateTaskResponse> {
  return fetchJson<DelegateTaskResponse>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(fromAgentId)}/delegate`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );
}

export interface BroadcastEventRequest {
  topic: string;
  content: string;
  context?: Record<string, unknown>;
}

export async function broadcastAgentEvent(
  botId: string,
  agentId: string,
  request: BroadcastEventRequest
): Promise<{ status: string; topic: string }> {
  return fetchJson<{ status: string; topic: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/broadcast`,
    {
      method: 'POST',
      body: JSON.stringify(request),
    }
  );
}
