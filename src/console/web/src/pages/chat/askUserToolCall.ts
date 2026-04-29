import type { ToolCall } from '../../api/types';

/** Identify ``ask_user`` agent calls so callers can swap in a custom UI. */
export function isAskUserToolCall(tc: ToolCall): boolean {
  return typeof tc.name === 'string' && tc.name === 'ask_user';
}
