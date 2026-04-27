import type { Agent } from '../../api/types_agents';

export const BUILTIN_CATEGORY_META: readonly { key: string; color: string }[] = [
  { key: 'all', color: '#1890ff' },
  { key: 'general', color: '#52c41a' },
  { key: 'content', color: '#ff7875' },
  { key: 'office', color: '#faad14' },
] as const;

export const TOPIC_RECOMMENDATIONS = ['agent.direct', 'system', 'task'] as const;
export const TOPIC_MAX_COUNT = 20;
export const TOPIC_MAX_LENGTH = 64;
export const TOPIC_PATTERN = /^[a-z0-9._-]{1,64}$/;

export interface TopicNormalizeResult {
  topics: string[];
  invalidFormat: string[];
  tooLong: string[];
  dedupedCount: number;
  overflowed: boolean;
}

/** Infer category from agent name or description. */
export function getAgentCategory(agent: Agent): string {
  const name = agent.name.toLowerCase();
  const desc = (agent.description || '').toLowerCase();
  const text = `${name} ${desc}`;

  if (text.includes('content') || text.includes('creator')) {
    return 'content';
  }
  if (text.includes('office') || text.includes('enterprise')) {
    return 'office';
  }
  return 'general';
}

export function resolveAgentCategory(
  agent: Agent,
  overrides: Record<string, string>,
): string {
  const o = overrides[agent.id];
  if (o) return o;
  return getAgentCategory(agent);
}

export function normalizeTopics(rawTopics: string[]): TopicNormalizeResult {
  const seen = new Set<string>();
  const topics: string[] = [];
  const invalidFormat: string[] = [];
  const tooLong: string[] = [];
  let dedupedCount = 0;
  let overflowed = false;

  for (const raw of rawTopics) {
    const topic = String(raw || '').trim().toLowerCase();
    if (!topic) continue;

    if (topic.length > TOPIC_MAX_LENGTH) {
      tooLong.push(topic);
      continue;
    }
    if (!TOPIC_PATTERN.test(topic)) {
      invalidFormat.push(topic);
      continue;
    }
    if (seen.has(topic)) {
      dedupedCount += 1;
      continue;
    }
    if (topics.length >= TOPIC_MAX_COUNT) {
      overflowed = true;
      continue;
    }
    seen.add(topic);
    topics.push(topic);
  }

  return { topics, invalidFormat, tooLong, dedupedCount, overflowed };
}
