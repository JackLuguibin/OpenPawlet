import type { SessionInfo } from "../../api/types";
import type { Agent } from "../../api/types_agents";
import type { RuntimeAgentStatus } from "../../api/types_runtime";

import { formatPeerAgentLabel } from "./agentEventDisplay";

/** id → display name from Console agent records. */
export function buildAgentNameById(agents: Agent[] | undefined): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of agents ?? []) {
    const name = (a.name ?? "").trim();
    if (a.id && name) {
      m.set(a.id, name);
    }
  }
  return m;
}

/**
 * Map raw runtime/bus ``agent_id`` (e.g. ``agent:main``, legacy ``main:<host>:<pid>``) to the Console
 * workspace persona display name when possible.
 */
export function resolveWorkspaceAgentDisplayName(
  rawId: string | undefined | null,
  agentNameById: Map<string, string>,
  runtimeAgents: RuntimeAgentStatus[] | undefined,
): string | undefined {
  const raw = rawId?.trim();
  if (!raw) {
    return undefined;
  }
  const direct = agentNameById.get(raw);
  if (direct) {
    return direct;
  }
  const surrogate =
    runtimeAgents?.find((r) => r.represents_gateway) ??
    runtimeAgents?.find((r) => r.role === "main");
  const pid = surrogate?.profile_id?.trim();
  if (pid) {
    const byPid = agentNameById.get(pid);
    if (byPid) {
      return byPid;
    }
  }
  // Fallback when snapshot lacks linkage: default gateway id or legacy ``main:*``.
  if (raw === "agent:main" || /^main:/.test(raw)) {
    const legacy = agentNameById.get("main");
    if (legacy) {
      return legacy;
    }
  }
  return undefined;
}

/** Default persona line for assistant bubbles in the active session. */
export function resolveDefaultAssistantLabel(params: {
  sessions: SessionInfo[] | undefined;
  activeSessionKey: string | undefined | null;
  agentNameById: Map<string, string>;
  runtimeAgents: RuntimeAgentStatus[] | undefined;
  consoleAgents: Agent[] | undefined;
  fallback: string;
}): string {
  const key = params.activeSessionKey?.trim();
  if (key && params.sessions) {
    const row = params.sessions.find((s) => s.key === key);
    if (row) {
      const an = (row.agent_name ?? "").trim();
      if (an) {
        return an;
      }
      const aid = (row.agent_id ?? "").trim();
      if (aid) {
        const mapped = resolveWorkspaceAgentDisplayName(
          aid,
          params.agentNameById,
          params.runtimeAgents,
        );
        if (mapped) {
          return mapped;
        }
      }
    }
  }

  const mainRt =
    params.runtimeAgents?.find((r) => r.role === "main") ??
    params.runtimeAgents?.find((r) => r.represents_gateway);
  if (mainRt?.profile_id) {
    const pid = mainRt.profile_id.trim();
    const n = params.agentNameById.get(pid);
    if (n) {
      return n;
    }
  }
  const rtLabel = (mainRt?.label ?? "").trim();
  if (rtLabel) {
    return rtLabel;
  }

  const firstEnabled = params.consoleAgents?.find((a) => a.enabled);
  const cap = (firstEnabled?.name ?? "").trim();
  if (cap) {
    return cap;
  }

  return params.fallback;
}

/** Per assistant bubble: prefer transcript-stamped ``agent_*`` from the runtime. */
export function resolveAssistantBubbleLabel(
  msg: {
    role: string;
    agent_name?: string;
    agent_id?: string;
    sender_agent_id?: string;
  },
  defaultLabel: string,
  agentNameById: Map<string, string>,
  runtimeAgents?: RuntimeAgentStatus[],
): string {
  if (msg.role !== "assistant") {
    return defaultLabel;
  }
  const stampedName = (msg.agent_name ?? "").trim();
  if (stampedName) {
    return stampedName;
  }
  const stampedId = (msg.agent_id ?? "").trim();
  if (stampedId) {
    return (
      resolveWorkspaceAgentDisplayName(stampedId, agentNameById, runtimeAgents) ??
      formatPeerAgentLabel(stampedId)
    );
  }
  const sid = msg.sender_agent_id?.trim();
  if (!sid) {
    return defaultLabel;
  }
  return (
    resolveWorkspaceAgentDisplayName(sid, agentNameById, runtimeAgents) ??
    formatPeerAgentLabel(sid)
  );
}
