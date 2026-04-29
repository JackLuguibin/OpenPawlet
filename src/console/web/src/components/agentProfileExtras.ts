import type { Agent, AgentUpdateRequest } from '../api/types_agents';

/**
 * Form values for the extended profile fields.
 *
 * All fields are optional and `null` means "inherit from main agent".
 * The parent component owns persistence — this panel only emits change
 * events so it can sit inside an Antd Modal alongside the legacy form.
 */
export interface AgentProfileExtras {
  max_tokens?: number | null;
  max_tool_iterations?: number | null;
  max_tool_result_chars?: number | null;
  context_window_tokens?: number | null;
  reasoning_effort?: string | null;
  timezone?: string | null;
  web_enabled?: boolean | null;
  exec_enabled?: boolean | null;
  mcp_servers_allowlist?: string[] | null;
  allowed_tools?: string[] | null;
  skills_denylist?: string[];
  use_own_bootstrap?: boolean;
  inherit_main_bootstrap?: boolean;
  /** Bind this agent to a specific LLM provider instance (id from /llm-providers). */
  provider_instance_id?: string | null;
}

/** Pull the extras-only subset out of an :class:`Agent` record. */
export function extractExtrasFromAgent(agent: Agent | null | undefined): AgentProfileExtras {
  if (!agent) {
    return {
      max_tokens: null,
      max_tool_iterations: null,
      max_tool_result_chars: null,
      context_window_tokens: null,
      reasoning_effort: null,
      timezone: null,
      web_enabled: null,
      exec_enabled: null,
      mcp_servers_allowlist: null,
      allowed_tools: null,
      skills_denylist: [],
      use_own_bootstrap: true,
      inherit_main_bootstrap: false,
      provider_instance_id: null,
    };
  }
  return {
    max_tokens: agent.max_tokens ?? null,
    max_tool_iterations: agent.max_tool_iterations ?? null,
    max_tool_result_chars: agent.max_tool_result_chars ?? null,
    context_window_tokens: agent.context_window_tokens ?? null,
    reasoning_effort: agent.reasoning_effort ?? null,
    timezone: agent.timezone ?? null,
    web_enabled: agent.web_enabled ?? null,
    exec_enabled: agent.exec_enabled ?? null,
    mcp_servers_allowlist: agent.mcp_servers_allowlist ?? null,
    allowed_tools: agent.allowed_tools ?? null,
    skills_denylist: agent.skills_denylist ?? [],
    use_own_bootstrap: agent.use_own_bootstrap ?? true,
    inherit_main_bootstrap: agent.inherit_main_bootstrap ?? false,
    provider_instance_id: agent.provider_instance_id ?? null,
  };
}

/** Merge extras onto an :class:`AgentUpdateRequest`. */
export function applyExtrasToUpdate(
  base: AgentUpdateRequest,
  extras: AgentProfileExtras,
): AgentUpdateRequest {
  return {
    ...base,
    max_tokens: extras.max_tokens ?? null,
    max_tool_iterations: extras.max_tool_iterations ?? null,
    max_tool_result_chars: extras.max_tool_result_chars ?? null,
    context_window_tokens: extras.context_window_tokens ?? null,
    reasoning_effort: extras.reasoning_effort ?? null,
    timezone: extras.timezone ?? null,
    web_enabled: extras.web_enabled ?? null,
    exec_enabled: extras.exec_enabled ?? null,
    mcp_servers_allowlist: extras.mcp_servers_allowlist ?? null,
    allowed_tools: extras.allowed_tools ?? null,
    skills_denylist: extras.skills_denylist ?? [],
    use_own_bootstrap: extras.use_own_bootstrap ?? true,
    inherit_main_bootstrap: extras.inherit_main_bootstrap ?? false,
    provider_instance_id: extras.provider_instance_id ?? null,
  };
}
