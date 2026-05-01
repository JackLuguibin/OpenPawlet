import type { ToolCall } from "../../api/types";

/**
 * Per-message UI shape used inside the Chat page (sidebar list, transcript
 * replay, streaming tail). Wider than the wire shape because it carries
 * UI-only fields (`isStreaming`, fallback `id`) and synthesized fields
 * (`reasoning_content` lifted from `thinking_blocks`, `source` filled in by
 * `normalizeMessageForChatRender`).
 *
 * Lives outside `Chat.tsx` so the helper modules in `pages/chat/` can share
 * the same shape without circular imports.
 */
export interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  isStreaming?: boolean;
  /** ISO timestamp shown next to the bubble. */
  created_at?: string;
  timestamp?: string;
  /** Origin tag: only `user` and `main_agent` render in the main timeline. */
  source?: "user" | "main_agent" | "sub_agent" | "tool_call";
  /** Inline tool calls embedded in the WS / transcript frame; rendered as a collapsible block. */
  tool_calls?: ToolCall[];
  /** Reasoning shown above tool-call blocks. */
  reasoning_content?: string;
  /** Anthropic extended thinking blocks persisted in transcript JSONL. */
  thinking_blocks?: Array<Record<string, unknown>>;
  /**
   * UUID identifying the entire assistant reply for this user turn.
   * Comes from the server (transcript JSONL or WS frame). When absent the
   * client falls back to a deterministic hash; see `groupAssistantReplies`.
   */
  reply_group_id?: string;
  /** Persisted loop identity (transcript / session JSONL). */
  agent_id?: string;
  agent_name?: string;
  /** Session row from ``agent.direct`` injection (peer agent message). */
  injected_event?: string;
  sender_agent_id?: string;
}

/**
 * Console WebSocket `tool_call` / `tool_result` tracking row. Distinct from
 * the inline `tool_calls` carried on assistant messages — the WS feed reports
 * tool lifecycle via standalone events that we want to render as their own
 * progress chips.
 */
export interface TrackedToolCall {
  id: string;
  name: string;
  args: string;
  status: "pending" | "running" | "success" | "error";
  result?: string;
}

/**
 * Parsed OpenPawlet `/status` payload (or legacy plain-text variant) reduced to
 * the context-meter slice the chat input needs.
 */
export interface OpenPawletContextUsage {
  tokens_estimate: number;
  window_total: number;
  percent_used: number;
}
