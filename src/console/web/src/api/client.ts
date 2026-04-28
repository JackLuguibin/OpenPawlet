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
  CronHistoryRun,
  CronJob,
  CronStatus,
  CronUpdateRequest,
  MCPStatus,
  MemoryResponse,
  SessionInfo,
  SessionDetail,
  StatusResponse,
  SkillInfo,
  SkillsGitRepo,
  SkillsGitRepoUpsertBody,
  SkillsGitSyncResult,
  ToolCallLog,
  RuntimeLogsData,
  BatchDeleteResponse,
  ActivityFeedPage,
  ChannelRefreshResult,
  MCPTestResult,
  ObservabilityResponse,
  AgentObservabilityTimeline,
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

// Swap the embedded runtime over to a different bot.  The console hosts
// at most one runtime at a time; this triggers a brief restart.
export async function activateBot(botId: string): Promise<BotInfo> {
  return fetchJson<BotInfo>(`${API_BASE}/bots/${encodeURIComponent(botId)}/activate`, {
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

/**
 * Chat history for refresh: prefers append-only transcript JSONL when present.
 *
 * Pass ``limit`` to fetch only the most recent N messages (or, with
 * ``beforeIndex``, the N messages ending just before that absolute index) for
 * lazy history loading. Without either parameter the backend returns the full
 * transcript (legacy shape).
 *
 * The response carries pagination metadata (``offset`` / ``total`` /
 * ``has_more``) only when paginated; otherwise those fields are undefined /
 * ``false`` and callers can keep treating the payload as the full history.
 */
export async function getSessionTranscript(
  key: string,
  botId?: string | null,
  options?: { limit?: number; beforeIndex?: number },
): Promise<{
  key: string;
  messages: unknown[];
  message_count: number;
  offset?: number | null;
  total?: number | null;
  has_more?: boolean;
}> {
  let url = `${API_BASE}/sessions/${encodeURIComponent(key)}/transcript`;
  url = appendBotQuery(url, botId);
  const params = new URLSearchParams();
  if (options?.limit !== undefined) {
    params.set('limit', String(options.limit));
  }
  if (options?.beforeIndex !== undefined) {
    params.set('before_index', String(options.beforeIndex));
  }
  const qs = params.toString();
  if (qs) {
    url += url.includes('?') ? `&${qs}` : `?${qs}`;
  }
  return fetchJson(url);
}

/** Verbatim on-disk JSONL (session store or append-only transcript) for debugging. */
export async function getSessionJsonlRaw(
  key: string,
  botId?: string | null,
  source: 'session' | 'transcript' = 'session',
): Promise<{ key: string; source: 'session' | 'transcript'; text: string }> {
  const base = `${API_BASE}/sessions/${encodeURIComponent(key)}/jsonl-raw`;
  if (source === 'transcript') {
    return fetchJson(appendBotQuery(`${base}?source=transcript`, botId));
  }
  return fetchJson(appendBotQuery(base, botId));
}

/** One per-turn snapshot of the real assembled LLM context (see SessionContextWriter). */
export interface SessionContextEntry {
  session_key?: string | null;
  bot_id?: string | null;
  channel?: string | null;
  chat_id?: string | null;
  turn_index?: number | null;
  source?: string | null;
  timestamp?: string | null;
  system_prompt?: string | null;
  messages?: unknown[] | null;
  message_count?: number | null;
  context_text?: string | null;
  [extra: string]: unknown;
}

export interface SessionContextPayload {
  key: string;
  latest: SessionContextEntry | null;
  text: string;
}

/**
 * Latest assembled-context snapshot stored at ``context/{key}.jsonl``.
 *
 * The file only exists after the first agent turn has completed, so a 404 is
 * expected for fresh sessions.  We normalise that into an empty payload so
 * callers can render an empty state instead of treating it as a query error.
 */
export async function getSessionContext(
  key: string,
  botId?: string | null,
): Promise<SessionContextPayload> {
  const url = appendBotQuery(
    `${API_BASE}/sessions/${encodeURIComponent(key)}/context`,
    botId,
  );
  try {
    return await fetchJson<SessionContextPayload>(url);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('404')) {
      return { key, latest: null, text: '' };
    }
    throw err;
  }
}

export async function createSession(
  keyOrOptions?:
    | string
    | {
        key?: string;
        team_id?: string;
        room_id?: string;
        agent_id?: string;
        ephemeral_session?: boolean;
      },
  botId?: string | null
): Promise<SessionInfo> {
  const payload =
    typeof keyOrOptions === 'string' || keyOrOptions === undefined
      ? { key: keyOrOptions }
      : keyOrOptions;
  return fetchJson<SessionInfo>(`${API_BASE}/sessions${botQuery(botId)}`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateSession(
  key: string,
  data: { title?: string | null },
  botId?: string | null
): Promise<SessionInfo> {
  return fetchJson<SessionInfo>(appendBotQuery(`${API_BASE}/sessions/${encodeURIComponent(key)}`, botId), {
    method: 'PATCH',
    body: JSON.stringify(data),
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
// Runtime logs (local log files)
// ====================

export async function getRuntimeLogs(
  source: 'all' | 'console' = 'all',
  options?: {
    limit?: number;
    cursor?: string | null;
    /** Legacy: still supported by backend, avoid for new code. */
    maxLines?: number;
  }
): Promise<RuntimeLogsData> {
  const params = new URLSearchParams({
    source,
  });
  if (options?.limit != null) {
    params.set('limit', String(options.limit));
  }
  if (options?.maxLines != null) {
    params.set('max_lines', String(options.maxLines));
  }
  if (options?.cursor) {
    params.set('cursor', options.cursor);
  }
  return fetchJson<RuntimeLogsData>(`${API_BASE}/runtime-logs?${params}`);
}

export async function clearRuntimeLogs(): Promise<{ status: string; path: string }> {
  return fetchJson<{ status: string; path: string }>(`${API_BASE}/runtime-logs/clear`, {
    method: 'POST',
  });
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

// ====================
// Skills Git source repos API
// ====================

export async function listSkillsGitRepos(
  botId?: string | null
): Promise<SkillsGitRepo[]> {
  return fetchJson<SkillsGitRepo[]>(`${API_BASE}/skills/git${botQuery(botId)}`);
}

export async function createSkillsGitRepo(
  body: SkillsGitRepoUpsertBody,
  botId?: string | null
): Promise<SkillsGitRepo> {
  return fetchJson<SkillsGitRepo>(`${API_BASE}/skills/git${botQuery(botId)}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateSkillsGitRepo(
  repoId: string,
  body: SkillsGitRepoUpsertBody,
  botId?: string | null
): Promise<SkillsGitRepo> {
  return fetchJson<SkillsGitRepo>(
    appendBotQuery(`${API_BASE}/skills/git/${encodeURIComponent(repoId)}`, botId),
    {
      method: 'PUT',
      body: JSON.stringify(body),
    }
  );
}

export async function deleteSkillsGitRepo(
  repoId: string,
  botId?: string | null
): Promise<{ status: string; name: string }> {
  return fetchJson(
    appendBotQuery(`${API_BASE}/skills/git/${encodeURIComponent(repoId)}`, botId),
    { method: 'DELETE' }
  );
}

export async function syncSkillsGitRepo(
  repoId: string,
  botId?: string | null
): Promise<SkillsGitSyncResult> {
  return fetchJson<SkillsGitSyncResult>(
    appendBotQuery(
      `${API_BASE}/skills/git/${encodeURIComponent(repoId)}/sync`,
      botId
    ),
    { method: 'POST' }
  );
}

export async function syncAllSkillsGitRepos(
  botId?: string | null
): Promise<SkillsGitSyncResult[]> {
  return fetchJson<SkillsGitSyncResult[]>(
    `${API_BASE}/skills/git/sync-all${botQuery(botId)}`,
    { method: 'POST' }
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

export async function getEnv(
  botId?: string | null
): Promise<{ vars: Record<string, string>; exec_visible_keys: string[] }> {
  return fetchJson<{ vars: Record<string, string>; exec_visible_keys: string[] }>(
    `${API_BASE}/env${botQuery(botId)}`
  );
}

export async function updateEnv(
  vars: Record<string, string>,
  botId?: string | null,
  execVisibleKeys?: string[]
): Promise<{ status: string; vars?: Record<string, string>; exec_visible_keys: string[] }> {
  return fetchJson(`${API_BASE}/env${botQuery(botId)}`, {
    method: 'PUT',
    body: JSON.stringify({
      vars,
      // omit when caller didn't pass it so legacy callers don't accidentally
      // wipe the existing exec allowlist
      ...(execVisibleKeys !== undefined ? { exec_visible_keys: execVisibleKeys } : {}),
    }),
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
): Promise<Record<string, CronHistoryRun[]>> {
  const params = new URLSearchParams();
  if (botId) params.set('bot_id', botId);
  if (jobId) params.set('job_id', jobId);
  return fetchJson<Record<string, CronHistoryRun[]>>(
    `${API_BASE}/cron/history?${params}`,
  );
}

export async function updateCronJob(
  jobId: string,
  data: CronUpdateRequest,
  botId?: string | null,
): Promise<CronJob> {
  return fetchJson<CronJob>(
    appendBotQuery(`${API_BASE}/cron/${encodeURIComponent(jobId)}`, botId),
    {
      method: 'PUT',
      body: JSON.stringify(data),
    },
  );
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
// Runtime Agent Manager (main + sub agents)
// ====================

export async function listRuntimeAgents(): Promise<
  import('./types_runtime').RuntimeAgentStatus[]
> {
  return fetchJson<import('./types_runtime').RuntimeAgentStatus[]>(
    `${API_BASE}/control/agents/status`,
  );
}

export async function getRuntimeAgentStatus(
  agentId: string,
): Promise<import('./types_runtime').RuntimeAgentStatus> {
  return fetchJson<import('./types_runtime').RuntimeAgentStatus>(
    `${API_BASE}/control/agents/${encodeURIComponent(agentId)}/status`,
  );
}

export async function startMainAgent(): Promise<
  import('./types_runtime').RuntimeControlResult
> {
  return fetchJson<import('./types_runtime').RuntimeControlResult>(
    `${API_BASE}/control/agents/main/start`,
    { method: 'POST' },
  );
}

export async function stopMainAgent(): Promise<
  import('./types_runtime').RuntimeControlResult
> {
  return fetchJson<import('./types_runtime').RuntimeControlResult>(
    `${API_BASE}/control/agents/main/stop`,
    { method: 'POST' },
  );
}

export async function startRuntimeSubagent(
  body: import('./types_runtime').RuntimeSubagentStartBody,
): Promise<import('./types_runtime').RuntimeControlResult> {
  return fetchJson<import('./types_runtime').RuntimeControlResult>(
    `${API_BASE}/control/agents/sub/start`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function stopRuntimeSubagent(
  agentId: string,
): Promise<import('./types_runtime').RuntimeControlResult> {
  return fetchJson<import('./types_runtime').RuntimeControlResult>(
    `${API_BASE}/control/agents/sub/${encodeURIComponent(agentId)}/stop`,
    { method: 'POST' },
  );
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

export async function getObservability(
  botId?: string | null
): Promise<ObservabilityResponse> {
  return fetchJson<ObservabilityResponse>(`${API_BASE}/observability${botQuery(botId)}`);
}

export async function getObservabilityTimeline(
  botId?: string | null,
  options?: { limit?: number; traceId?: string | null }
): Promise<AgentObservabilityTimeline> {
  const p = new URLSearchParams();
  p.set('limit', String(options?.limit ?? 200));
  if (options?.traceId) {
    p.set('trace_id', options.traceId);
  }
  const withQuery = `${API_BASE}/observability/timeline?${p.toString()}`;
  return fetchJson<AgentObservabilityTimeline>(appendBotQuery(withQuery, botId));
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

export async function deleteWorkspaceFile(
  path: string,
  botId?: string | null
): Promise<{ status: string; path: string }> {
  const params = new URLSearchParams({ path });
  return fetchJson(appendBotQuery(`${API_BASE}/workspace/file?${params}`, botId), {
    method: 'DELETE',
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

export async function getRecentActivity(opts: {
  botId?: string | null;
  activityType?: string;
  skip?: number;
  limit?: number;
}): Promise<ActivityFeedPage> {
  const { botId, activityType, skip = 0, limit = 20 } = opts;
  const params = new URLSearchParams({
    skip: String(skip),
    limit: String(limit),
  });
  if (botId) params.append('bot_id', botId);
  if (activityType) params.append('activity_type', activityType);
  return fetchJson<ActivityFeedPage>(`${API_BASE}/activity?${params}`);
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

// --------------------
// Per-agent bootstrap files (independent persona)
// --------------------

export async function getAgentBootstrap(
  botId: string,
  agentId: string,
): Promise<import('./types_agents').AgentBootstrapFiles> {
  return fetchJson<import('./types_agents').AgentBootstrapFiles>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/bootstrap`,
  );
}

export async function updateAgentBootstrap(
  botId: string,
  agentId: string,
  key: import('./types_agents').AgentBootstrapKey,
  content: string,
): Promise<{ key: string }> {
  return fetchJson<{ key: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/bootstrap/${encodeURIComponent(key)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ content }),
    },
  );
}

export async function deleteAgentBootstrap(
  botId: string,
  agentId: string,
  key: import('./types_agents').AgentBootstrapKey,
): Promise<{ key: string }> {
  return fetchJson<{ key: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/agents/${encodeURIComponent(agentId)}/bootstrap/${encodeURIComponent(key)}`,
    {
      method: 'DELETE',
    },
  );
}

// ====================
// Teams API
// ====================

export async function listTeams(botId: string): Promise<import('./types_teams').Team[]> {
  return fetchJson<import('./types_teams').Team[]>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams`
  );
}

export async function createTeam(
  botId: string,
  data: import('./types_teams').TeamCreateRequest
): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(`${API_BASE}/bots/${encodeURIComponent(botId)}/teams`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getTeam(botId: string, teamId: string): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}`
  );
}

export async function updateTeam(
  botId: string,
  teamId: string,
  data: import('./types_teams').TeamUpdateRequest
): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(data),
    }
  );
}

export async function deleteTeam(botId: string, teamId: string): Promise<{ status: string }> {
  return fetchJson<{ status: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}`,
    { method: 'DELETE' }
  );
}

export async function addTeamMember(botId: string, teamId: string, agentId: string): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/members`,
    {
      method: 'POST',
      body: JSON.stringify({ agent_id: agentId }),
    }
  );
}

export async function removeTeamMember(
  botId: string,
  teamId: string,
  agentId: string
): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agentId)}`,
    { method: 'DELETE' }
  );
}

export async function updateTeamMember(
  botId: string,
  teamId: string,
  agentId: string,
  data: { ephemeral_session?: boolean }
): Promise<import('./types_teams').Team> {
  return fetchJson<import('./types_teams').Team>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(agentId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(data),
    }
  );
}

export async function createTeamRoom(
  botId: string,
  teamId: string
): Promise<import('./types_teams').TeamRoomCreateResponse> {
  return fetchJson<import('./types_teams').TeamRoomCreateResponse>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/rooms`,
    { method: 'POST' }
  );
}

export async function listTeamRooms(botId: string, teamId: string): Promise<import('./types_teams').TeamRoom[]> {
  return fetchJson<import('./types_teams').TeamRoom[]>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/rooms`
  );
}

export async function deleteTeamRoom(
  botId: string,
  teamId: string,
  roomId: string
): Promise<import('./types_teams').TeamRoomDeleteResponse> {
  return fetchJson<import('./types_teams').TeamRoomDeleteResponse>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/rooms/${encodeURIComponent(roomId)}`,
    { method: 'DELETE' }
  );
}

export async function getTeamRoomTranscript(
  botId: string,
  teamId: string,
  roomId: string
): Promise<import('./types_teams').TeamTranscriptResponse> {
  return fetchJson<import('./types_teams').TeamTranscriptResponse>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/teams/${encodeURIComponent(teamId)}/rooms/${encodeURIComponent(roomId)}/transcript`
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

// ====================
// Queue Manager API
// ====================

export interface QueueTopologyEntry {
  role: string;
  bind: string;
  connect_hint: string;
}

export interface QueueConnectionInfo {
  socket: string;
  peer: string;
  since: number;
  last_event: string;
  last_event_at: number;
  event_count: number;
}

export interface QueueSampleInfo {
  at: number;
  direction: string;
  kind: string;
  message_id: string;
  session_key: string;
  bytes: number;
  trace_id: string;
}

export interface QueueSnapshot {
  status: string;
  version: string;
  uptime_s: number;
  settings: {
    host: string;
    health_host: string;
    health_port: number;
    sample_capacity: number;
    idempotency_window_seconds: number;
    admin_token_configured: boolean;
  };
  topology: {
    ingress: QueueTopologyEntry;
    worker: QueueTopologyEntry;
    egress: QueueTopologyEntry;
    delivery: QueueTopologyEntry;
    events_ingress?: QueueTopologyEntry;
    events_delivery?: QueueTopologyEntry;
  };
  metrics: Record<string, number>;
  rates: Record<string, number>;
  paused: { inbound: boolean; outbound: boolean; events?: boolean };
  dedupe: {
    hits: number;
    misses: number;
    size: number;
    persist_size: number;
  };
  connections: QueueConnectionInfo[];
  samples: QueueSampleInfo[];
}

export async function getQueueSnapshot(): Promise<QueueSnapshot> {
  return fetchJson<QueueSnapshot>(`${API_BASE}/queues/snapshot`);
}

export async function pauseQueue(
  direction: 'inbound' | 'outbound' | 'events' | 'both' | 'all',
  paused: boolean
): Promise<{
  paused: { inbound: boolean; outbound: boolean; events?: boolean };
  changed: string[];
}> {
  return fetchJson(`${API_BASE}/queues/pause`, {
    method: 'POST',
    body: JSON.stringify({ direction, paused }),
  });
}

export async function replayQueueMessage(
  messageId: string
): Promise<{ message_id: string; direction: string }> {
  return fetchJson(`${API_BASE}/queues/replay`, {
    method: 'POST',
    body: JSON.stringify({ message_id: messageId }),
  });
}

export async function clearQueueDedupe(
  scope: 'memory' | 'persist' | 'both'
): Promise<{ scope: string; memory_cleared: number; persist_bytes_cleared: number }> {
  return fetchJson(`${API_BASE}/queues/dedupe/clear`, {
    method: 'POST',
    body: JSON.stringify({ scope }),
  });
}

// ====================
// LLM Provider Instances API
// ====================

export async function listLLMProviders(
  botId: string,
): Promise<import('./types_llm_providers').LLMProviderInstance[]> {
  return fetchJson<import('./types_llm_providers').LLMProviderInstance[]>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers`,
  );
}

export async function getLLMProvider(
  botId: string,
  instanceId: string,
): Promise<import('./types_llm_providers').LLMProviderInstance> {
  return fetchJson<import('./types_llm_providers').LLMProviderInstance>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}`,
  );
}

export async function createLLMProvider(
  botId: string,
  body: import('./types_llm_providers').LLMProviderInstanceCreate,
): Promise<import('./types_llm_providers').LLMProviderInstance> {
  return fetchJson<import('./types_llm_providers').LLMProviderInstance>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers`,
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function updateLLMProvider(
  botId: string,
  instanceId: string,
  body: import('./types_llm_providers').LLMProviderInstanceUpdate,
): Promise<import('./types_llm_providers').LLMProviderInstance> {
  return fetchJson<import('./types_llm_providers').LLMProviderInstance>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}`,
    {
      method: 'PUT',
      body: JSON.stringify(body),
    },
  );
}

export async function deleteLLMProvider(
  botId: string,
  instanceId: string,
): Promise<{ status: string }> {
  return fetchJson<{ status: string }>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}`,
    { method: 'DELETE' },
  );
}

export async function testLLMProvider(
  botId: string,
  instanceId: string,
): Promise<import('./types_llm_providers').LLMProviderTestResult> {
  return fetchJson<import('./types_llm_providers').LLMProviderTestResult>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}/test`,
    { method: 'POST' },
  );
}

export async function setDefaultLLMProvider(
  botId: string,
  instanceId: string,
): Promise<import('./types_llm_providers').LLMProviderInstance> {
  return fetchJson<import('./types_llm_providers').LLMProviderInstance>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}/set-default`,
    { method: 'POST' },
  );
}

export async function listLLMProviderRegistry(
  botId: string,
): Promise<import('./types_llm_providers').LLMProviderRegistryEntry[]> {
  return fetchJson<import('./types_llm_providers').LLMProviderRegistryEntry[]>(
    `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/registry`,
  );
}

// ----------------------------------------------------------------------
// Per-instance API key sub-resource
// ----------------------------------------------------------------------

const KEYS_BASE = (botId: string, instanceId: string) =>
  `${API_BASE}/bots/${encodeURIComponent(botId)}/llm-providers/${encodeURIComponent(instanceId)}/keys`;

export async function listLLMProviderKeys(
  botId: string,
  instanceId: string,
): Promise<import('./types_llm_providers').MaskedApiKey[]> {
  return fetchJson<import('./types_llm_providers').MaskedApiKey[]>(
    KEYS_BASE(botId, instanceId),
  );
}

export async function addLLMProviderKey(
  botId: string,
  instanceId: string,
  body: import('./types_llm_providers').ApiKeyAddBody,
): Promise<import('./types_llm_providers').MaskedApiKey> {
  return fetchJson<import('./types_llm_providers').MaskedApiKey>(
    KEYS_BASE(botId, instanceId),
    {
      method: 'POST',
      body: JSON.stringify(body),
    },
  );
}

export async function patchLLMProviderKey(
  botId: string,
  instanceId: string,
  keyId: string,
  body: import('./types_llm_providers').ApiKeyPatchBody,
): Promise<import('./types_llm_providers').MaskedApiKey> {
  return fetchJson<import('./types_llm_providers').MaskedApiKey>(
    `${KEYS_BASE(botId, instanceId)}/${encodeURIComponent(keyId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(body),
    },
  );
}

export async function deleteLLMProviderKey(
  botId: string,
  instanceId: string,
  keyId: string,
): Promise<{ status: string }> {
  return fetchJson<{ status: string }>(
    `${KEYS_BASE(botId, instanceId)}/${encodeURIComponent(keyId)}`,
    { method: 'DELETE' },
  );
}

export async function reorderLLMProviderKeys(
  botId: string,
  instanceId: string,
  orderedIds: string[],
): Promise<import('./types_llm_providers').MaskedApiKey[]> {
  return fetchJson<import('./types_llm_providers').MaskedApiKey[]>(
    `${KEYS_BASE(botId, instanceId)}/reorder`,
    {
      method: 'POST',
      body: JSON.stringify({ orderedIds }),
    },
  );
}

export async function revealLLMProviderKey(
  botId: string,
  instanceId: string,
  keyId: string,
): Promise<import('./types_llm_providers').ApiKeyRevealResult> {
  return fetchJson<import('./types_llm_providers').ApiKeyRevealResult>(
    `${KEYS_BASE(botId, instanceId)}/${encodeURIComponent(keyId)}/reveal`,
    { method: 'POST' },
  );
}
