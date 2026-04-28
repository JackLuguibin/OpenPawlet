/**
 * Cron job message metadata helpers.
 *
 * The backend persists a cron job's instruction in `payload.message` as a
 * plain string. To support richer task targets (agent / skills / tools /
 * active time window) without changing the wire schema, we encode an
 * optional metadata block in front of the user prompt:
 *
 *     <!--cron-meta:{...json...}-->\n
 *     <user prompt body>
 *
 * Old jobs without the marker are treated as plain prompts.
 */

export interface CronTaskMetadata {
  /** Target agent id (optional; empty = use main agent). */
  agentId?: string | null;
  /** Skills the agent should be allowed / encouraged to use. */
  skills?: string[];
  /** MCP server names whose tools should be enabled. */
  mcpServers?: string[];
  /** Specific tools (free-form names) to highlight in the prompt. */
  tools?: string[];
  /** Active window start (epoch ms). Job is skipped before this time. */
  startAtMs?: number | null;
  /** Active window end (epoch ms). Job auto-disables after this. */
  endAtMs?: number | null;
}

const META_MARKER_RE = /^<!--cron-meta:(\{[\s\S]*?\})-->\r?\n?/;

/** Encode metadata + prompt body into a single message string. */
export function encodeCronMessage(prompt: string, meta: CronTaskMetadata): string {
  const cleaned: CronTaskMetadata = {};
  if (meta.agentId) cleaned.agentId = meta.agentId;
  if (meta.skills && meta.skills.length) cleaned.skills = [...meta.skills];
  if (meta.mcpServers && meta.mcpServers.length) cleaned.mcpServers = [...meta.mcpServers];
  if (meta.tools && meta.tools.length) cleaned.tools = [...meta.tools];
  if (typeof meta.startAtMs === 'number') cleaned.startAtMs = meta.startAtMs;
  if (typeof meta.endAtMs === 'number') cleaned.endAtMs = meta.endAtMs;

  const hasAny = Object.keys(cleaned).length > 0;
  if (!hasAny) return prompt;
  const json = JSON.stringify(cleaned);
  return `<!--cron-meta:${json}-->\n${prompt}`;
}

/** Decode a stored message back into metadata + user-visible prompt. */
export function decodeCronMessage(raw: string | null | undefined): {
  meta: CronTaskMetadata;
  prompt: string;
} {
  if (!raw) return { meta: {}, prompt: '' };
  const match = raw.match(META_MARKER_RE);
  if (!match) return { meta: {}, prompt: raw };
  let meta: CronTaskMetadata = {};
  try {
    const parsed = JSON.parse(match[1]) as CronTaskMetadata;
    if (parsed && typeof parsed === 'object') meta = parsed;
  } catch {
    meta = {};
  }
  return { meta, prompt: raw.slice(match[0].length) };
}

/** True when an end window has passed. */
export function isMetadataExpired(meta: CronTaskMetadata, nowMs: number = Date.now()): boolean {
  return typeof meta.endAtMs === 'number' && meta.endAtMs > 0 && nowMs > meta.endAtMs;
}

/** True when start window has not yet been reached. */
export function isMetadataNotYetActive(
  meta: CronTaskMetadata,
  nowMs: number = Date.now(),
): boolean {
  return typeof meta.startAtMs === 'number' && meta.startAtMs > 0 && nowMs < meta.startAtMs;
}

/** Render a friendly summary string for a 5-field cron expression. */
export function summarizeCron(
  expr: string,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return '';
  const [m, h, dom, mon, dow] = parts;
  const padded = (n: string) => n.padStart(2, '0');

  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return t('cron.summaryEveryMinute');
  }
  const everyN = m.match(/^\*\/(\d+)$/);
  if (everyN && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return t('cron.summaryEveryNMinutes', { count: Number(everyN[1]) });
  }
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
    return t('cron.summaryHourlyAt', { minute: padded(m) });
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') {
    return t('cron.summaryDailyAt', { time: `${padded(h)}:${padded(m)}` });
  }
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    dom === '*' &&
    mon === '*' &&
    /^[0-6](?:[-,][0-6])*$/.test(dow)
  ) {
    return t('cron.summaryWeeklyAt', {
      time: `${padded(h)}:${padded(m)}`,
      days: dow,
    });
  }
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && /^\d+$/.test(dom) && mon === '*' && dow === '*') {
    return t('cron.summaryMonthlyAt', {
      day: dom,
      time: `${padded(h)}:${padded(m)}`,
    });
  }
  return '';
}
