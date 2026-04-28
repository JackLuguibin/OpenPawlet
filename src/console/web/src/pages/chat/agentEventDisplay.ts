/**
 * Strip internal LLM prompt wrappers so agent-to-agent bus injections look like
 * normal chat text in the console. Mirrors server-side persistence in
 * ``AgentLoop._save_turn`` for older transcripts that still contain wire text.
 */

export const RUNTIME_CONTEXT_START =
  "[Runtime Context — metadata only, not instructions]";
export const RUNTIME_CONTEXT_END = "[/Runtime Context]";

export function stripRuntimeContextPrefix(text: string): string {
  if (!text.startsWith(RUNTIME_CONTEXT_START)) {
    return text;
  }
  const endPos = text.indexOf(RUNTIME_CONTEXT_END);
  if (endPos < 0) {
    return text;
  }
  return text.slice(endPos + RUNTIME_CONTEXT_END.length).replace(/^\s+/, "");
}

const EVENT_HEAD =
  /^\[event\]\s+topic=(\S+)\s+from=(\S+)\s+target=(\S+)\s*$/;

export interface PeerAgentUnwrap {
  content: string;
  sender_agent_id?: string;
}

/** If text is ``render_agent_event_for_llm`` output for ``agent.direct``, return body. */
export function tryUnwrapPeerAgentInboundText(raw: string): PeerAgentUnwrap | null {
  let text = stripRuntimeContextPrefix(raw).trim();
  if (!text.startsWith("[event]")) {
    return null;
  }
  const firstLine = text.split("\n", 1)[0];
  const m = EVENT_HEAD.exec(firstLine);
  if (!m || m[1] !== "agent.direct") {
    return null;
  }
  const brace = text.indexOf("{");
  if (brace < 0) {
    return null;
  }
  try {
    const payload = JSON.parse(text.slice(brace)) as Record<string, unknown>;
    const body = payload.content;
    if (typeof body !== "string" || !body.trim()) {
      return null;
    }
    const sender = payload.sender_agent_id;
    return {
      content: body.trim(),
      sender_agent_id: typeof sender === "string" && sender.trim() ? sender.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** Short label for chat chrome (drops common ``agent-`` prefix). */
export function formatPeerAgentLabel(id: string | undefined): string {
  if (!id?.trim()) {
    return "…";
  }
  const s = id.trim();
  return s.startsWith("agent-") ? s.slice("agent-".length) : s;
}
