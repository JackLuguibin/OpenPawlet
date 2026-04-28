import type { ToolCall } from "../../api/types";
import { normalizeToolCallsArray } from "../../utils/toolCalls";
import type { Message } from "./types";
import { tryUnwrapPeerAgentInboundText } from "./agentEventDisplay";

/**
 * Split an agent `tool_hint` into multiple lines so back-to-back calls like
 * `read_file("a")read_file("b")` do not collapse onto a single line in the UI.
 */
export function formatToolHintMultiline(hint: string): string {
  return hint.replace(/\),\s*(?=[A-Za-z_]\w*\()/g, ")\n");
}

/** JSON.stringify length heuristic for merging streaming tool call argument snapshots. */
export function toolCallArgumentsPayloadScore(
  args: Record<string, unknown>,
): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return 0;
  }
}

/**
 * Merge successive `chat_token` / `tool_event` batches: keep prior tool calls
 * and append new ids; for the same id, prefer richer arguments and the latest
 * result. (OpenPawlet often sends one batch per tool round — the old
 * implementation only returned `incoming.length` entries and dropped earlier
 * calls.)
 */
export function mergeStreamingToolCalls(
  prev: ToolCall[],
  incoming: ToolCall[],
): ToolCall[] {
  if (incoming.length === 0) {
    return prev;
  }
  const byId = new Map<string, ToolCall>();
  const order: string[] = [];

  for (const tc of prev) {
    if (!byId.has(tc.id)) {
      order.push(tc.id);
    }
    byId.set(tc.id, tc);
  }

  for (const tc of incoming) {
    const old = byId.get(tc.id);
    if (!old) {
      order.push(tc.id);
      byId.set(tc.id, tc);
      continue;
    }
    const scoreOld = toolCallArgumentsPayloadScore(old.arguments);
    const scoreNew = toolCallArgumentsPayloadScore(tc.arguments);
    const merged =
      scoreNew >= scoreOld
        ? {
            ...tc,
            name: tc.name || old.name,
            tool_call_type: tc.tool_call_type ?? old.tool_call_type,
            result: tc.result !== undefined ? tc.result : old.result,
          }
        : {
            ...tc,
            name: tc.name || old.name,
            arguments: old.arguments,
            tool_call_type: tc.tool_call_type ?? old.tool_call_type,
            result: tc.result !== undefined ? tc.result : old.result,
          };
    byId.set(tc.id, merged);
  }

  return order.map((id) => byId.get(id)!);
}

/**
 * Walk messages in order: for each `role === "tool"` with `tool_call_id`, set
 * `result` on the matching entry in the nearest preceding assistant
 * `tool_calls`. Those tool messages are omitted from the output; unmatched
 * tool rows are kept.
 */
export function mergeToolResultsIntoAssistantMessages(
  messages: Message[],
): Message[] {
  const out: Message[] = [];

  const cloneForMerge = (msg: Message): Message => ({
    ...msg,
    tool_calls: msg.tool_calls?.map((tc) => ({ ...tc })),
  });

  for (const msg of messages) {
    if (msg.role === "tool" && msg.tool_call_id) {
      const callId = msg.tool_call_id;
      let merged = false;
      for (let i = out.length - 1; i >= 0; i--) {
        const prior = out[i];
        if (prior.role !== "assistant" || !prior.tool_calls?.length) {
          continue;
        }
        const tidx = prior.tool_calls.findIndex((tc) => tc.id === callId);
        if (tidx === -1) {
          continue;
        }
        const updatedCalls = prior.tool_calls.map((tc, j) =>
          j === tidx ? { ...tc, result: msg.content } : tc,
        );
        out[i] = { ...prior, tool_calls: updatedCalls };
        merged = true;
        break;
      }
      if (!merged) {
        out.push(cloneForMerge(msg));
      }
      continue;
    }
    out.push(cloneForMerge(msg));
  }
  return out;
}

export function extractReasoningFromThinkingBlocks(
  thinkingBlocks: unknown,
): string | undefined {
  if (!Array.isArray(thinkingBlocks) || thinkingBlocks.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  for (const row of thinkingBlocks) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      continue;
    }
    const block = row as Record<string, unknown>;
    for (const key of ["thinking", "text", "content"] as const) {
      const value = block[key];
      if (typeof value === "string" && value.trim()) {
        parts.push(value.trim());
        break;
      }
    }
  }
  if (parts.length === 0) {
    return undefined;
  }
  return parts.join("\n\n");
}

export function normalizeMessageForChatRender(msg: Message): Message {
  const normalizedToolCalls = normalizeToolCallsArray(
    msg.tool_calls as unknown,
  );
  const normalizedReasoning =
    typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()
      ? msg.reasoning_content
      : extractReasoningFromThinkingBlocks(msg.thinking_blocks);

  let content =
    typeof msg.content === "string" ? msg.content : String(msg.content ?? "");
  let injected_event = msg.injected_event;
  let sender_agent_id = msg.sender_agent_id;

  if (msg.role === "user" && !injected_event) {
    const peer = tryUnwrapPeerAgentInboundText(content);
    if (peer) {
      content = peer.content;
      injected_event = "agent_direct";
      sender_agent_id = peer.sender_agent_id;
    }
  }

  const normalizedSource =
    msg.source ??
    (msg.role === "user"
      ? "user"
      : msg.role === "assistant"
        ? "main_agent"
        : undefined);

  return {
    ...msg,
    content,
    source: normalizedSource,
    ...(injected_event ? { injected_event } : {}),
    ...(sender_agent_id ? { sender_agent_id } : {}),
    ...(normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {}),
    ...(normalizedReasoning ? { reasoning_content: normalizedReasoning } : {}),
  };
}

export function appendReplySection(base: string, incoming: string): string {
  const left = base.trim();
  const right = incoming.trim();
  if (!right) {
    return base;
  }
  if (!left) {
    return incoming;
  }
  if (left === right || left.endsWith(right)) {
    return base;
  }
  return `${base}\n\n${incoming}`;
}

/**
 * Hash a string into a deterministic UUID-shaped identifier (8-4-4-4-12 hex).
 *
 * We use a hand-rolled FNV-1a + xorshift mixer instead of `crypto.subtle` so
 * the function stays synchronous and works under React render. Collisions are
 * astronomically unlikely for the input space (anchor + role + ts + content
 * head) and the result is purely client-side, so it does not need to match
 * RFC 4122 cryptographically — the goal is a stable React key + group id.
 */
export function hashStringToUuid(input: string): string {
  let h1 = 0x811c9dc5 ^ input.length;
  let h2 = 0xdeadbeef ^ input.length;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193);
    h2 = Math.imul(h2 ^ code, 0x85ebca6b);
  }
  h1 = (h1 ^ (h1 >>> 16)) >>> 0;
  h2 = (h2 ^ (h2 >>> 13)) >>> 0;
  const a = h1.toString(16).padStart(8, "0");
  const b = (h2 & 0xffff).toString(16).padStart(4, "0");
  const c = ((h2 >>> 16) & 0x0fff | 0x4000).toString(16).padStart(4, "0");
  const d = ((h1 ^ h2) & 0x3fff | 0x8000).toString(16).padStart(4, "0");
  const eRaw = ((Math.imul(h1, 0x9e3779b9) ^ h2) >>> 0).toString(16);
  const e = (eRaw + h2.toString(16)).slice(0, 12).padStart(12, "0");
  return `${a}-${b}-${c}-${d}-${e}`;
}

/**
 * Build a stable group UUID for one assistant reply.
 *
 * Anchor priority:
 *
 * 1. The first assistant message's id (already stable across renders, see
 *    `buildStableMessageId` for transcript rows and the `msg-${ts}` ids for
 *    streamed bubbles).
 * 2. Timestamp + role + content head as a fallback when ids are missing
 *    (defensive — should not happen in practice).
 *
 * The same anchor produces the same UUID on transcript replay and WS
 * streaming, which is what keeps the rendered "group" stable across the two
 * transports.
 */
export function buildReplyGroupUuid(anchor: Message): string {
  const seedParts = [
    anchor.id || "",
    anchor.role,
    anchor.created_at || anchor.timestamp || "",
    (anchor.content || "").slice(0, 64),
  ];
  return hashStringToUuid(seedParts.join("|"));
}

/**
 * Fold adjacent assistant chunks (tool-planning + final answer, etc.) into one
 * visual group so transcript replay matches WS live rendering.
 *
 * Each group carries:
 * - `reply_group_id`: stable UUID derived from the first chunk in the group;
 *   used for analytics, observability cross-links, and as the React key prefix
 *   so re-renders during streaming do not remount the bubble.
 * - `id`: `grp-${uuid}` so the virtualized list keeps a unique row key even
 *   when two adjacent groups share their first chunk's content head.
 */
export function resolveAssistantGroupId(msg: Message): string {
  if (typeof msg.reply_group_id === "string" && msg.reply_group_id.trim()) {
    return msg.reply_group_id;
  }
  return buildReplyGroupUuid(msg);
}

/**
 * Build a deterministic row id for one rendered assistant group.
 *
 * `reply_group_id` may be reused by the backend in edge cases (e.g. retried
 * synthetic status turns), so `grp-${reply_group_id}` alone is not guaranteed
 * unique inside one rendered list. Include the first message anchor to keep
 * React keys unique while preserving the original `reply_group_id` for logic.
 */
export function buildAssistantGroupRowId(msg: Message, groupId: string): string {
  const anchorSeed = [
    msg.id || "",
    msg.created_at || msg.timestamp || "",
    (msg.content || "").slice(0, 64),
  ].join("|");
  return `grp-${groupId}-${hashStringToUuid(anchorSeed)}`;
}

export function groupAssistantReplies(messages: Message[]): Message[] {
  const out: Message[] = [];
  let activeGroup: Message | null = null;
  const usedGroupRowIds = new Set<string>();

  const claimUniqueGroupRowId = (msg: Message, groupId: string): string => {
    const base = buildAssistantGroupRowId(msg, groupId);
    if (!usedGroupRowIds.has(base)) {
      usedGroupRowIds.add(base);
      return base;
    }
    let n = 2;
    let next = `${base}-${n}`;
    while (usedGroupRowIds.has(next)) {
      n += 1;
      next = `${base}-${n}`;
    }
    usedGroupRowIds.add(next);
    return next;
  };

  const flushGroup = () => {
    if (!activeGroup) {
      return;
    }
    out.push(activeGroup);
    activeGroup = null;
  };

  for (const raw of messages) {
    const msg = normalizeMessageForChatRender(raw);
    if (msg.role !== "assistant") {
      flushGroup();
      out.push(msg);
      continue;
    }
    const incomingGroupId = resolveAssistantGroupId(msg);
    if (
      activeGroup &&
      activeGroup.reply_group_id &&
      activeGroup.reply_group_id !== incomingGroupId
    ) {
      // Server-issued reply_group_id changed — start a new group even though
      // both messages are assistant role (e.g. two distinct turns persisted
      // back-to-back without an intervening user row).
      flushGroup();
    }
    if (!activeGroup) {
      activeGroup = {
        ...msg,
        id: claimUniqueGroupRowId(msg, incomingGroupId),
        reply_group_id: incomingGroupId,
      };
      continue;
    }
    activeGroup = {
      ...activeGroup,
      content: appendReplySection(activeGroup.content, msg.content),
      tool_calls: mergeStreamingToolCalls(
        activeGroup.tool_calls ?? [],
        msg.tool_calls ?? [],
      ),
      reasoning_content: appendReplySection(
        activeGroup.reasoning_content ?? "",
        msg.reasoning_content ?? "",
      ),
      created_at: msg.created_at ?? activeGroup.created_at,
      timestamp: msg.timestamp ?? activeGroup.timestamp,
    };
  }

  flushGroup();
  return out;
}
