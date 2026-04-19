import type { ToolCall } from "../api/types";

/**
 * Parse `function.arguments` from API / WebSocket: object or JSON string.
 */
export function parseArgumentsRecord(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) {
    return {};
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) {
      return {};
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { _raw: trimmed };
    } catch {
      return { _raw: raw };
    }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return { _value: raw };
}

/**
 * Normalize one OpenAI-style tool call item:
 * `{ id, type, function: { name, arguments } }` or flat `{ id, name, arguments }`.
 */
export function normalizeToolCallEntry(
  raw: unknown,
  index: number,
): ToolCall | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const rawId = o.id;
  const id =
    typeof rawId === "string" && rawId.length > 0
      ? rawId
      : typeof rawId === "number" && Number.isFinite(rawId)
        ? String(rawId)
        : `tool-call-${index}`;
  let name = "";
  let args: Record<string, unknown> = {};
  const fn = o.function;
  if (fn && typeof fn === "object" && !Array.isArray(fn)) {
    const f = fn as Record<string, unknown>;
    name = typeof f.name === "string" ? f.name : "";
    args = parseArgumentsRecord(f.arguments);
  } else {
    name = typeof o.name === "string" ? o.name : "";
    args = parseArgumentsRecord(o.arguments);
  }
  if (!name) {
    return null;
  }
  const tool_call_type =
    typeof o.type === "string" && o.type.length > 0 ? o.type : undefined;
  const result = typeof o.result === "string" ? o.result : undefined;
  return {
    id,
    name,
    arguments: args,
    ...(tool_call_type !== undefined ? { tool_call_type } : {}),
    ...(result !== undefined ? { result } : {}),
  };
}

/**
 * Normalize a `tool_calls` array from stream or session JSON (may be raw API shape).
 */
export function normalizeToolCallsArray(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: ToolCall[] = [];
  raw.forEach((entry, idx) => {
    const tc = normalizeToolCallEntry(entry, idx);
    if (tc) {
      out.push(tc);
    }
  });
  return out;
}

function toolResultTextFromUnknown(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalize `tool_results` from nanobot WebSocket `tool_event` frames (shapes vary by backend).
 */
export function normalizeToolResultItems(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byIdLastWins = new Map<string, ToolCall>();
  raw.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") {
      return;
    }
    const o = entry as Record<string, unknown>;
    const tcId = o.tool_call_id;
    const tcIdAlt = o.toolCallId;
    const oid = o.id;
    let rawId = "";
    if (typeof tcId === "string" && tcId.length > 0) {
      rawId = tcId;
    } else if (typeof tcId === "number" && Number.isFinite(tcId)) {
      rawId = String(tcId);
    } else if (typeof tcIdAlt === "string" && tcIdAlt.length > 0) {
      rawId = tcIdAlt;
    } else if (typeof tcIdAlt === "number" && Number.isFinite(tcIdAlt)) {
      rawId = String(tcIdAlt);
    } else if (typeof oid === "string" && oid.length > 0) {
      rawId = oid;
    } else if (typeof oid === "number" && Number.isFinite(oid)) {
      rawId = String(oid);
    }
    const id =
      rawId.length > 0 ? rawId : `tool-result-${idx}`;
    let name = typeof o.name === "string" ? o.name : "";
    const fn = o.function;
    if (!name && fn && typeof fn === "object" && !Array.isArray(fn)) {
      const f = fn as Record<string, unknown>;
      name = typeof f.name === "string" ? f.name : "";
    }
    let resultText: string | undefined;
    if (typeof o.result === "string") {
      resultText = o.result;
    } else if (o.result !== undefined) {
      resultText = toolResultTextFromUnknown(o.result);
    } else if (typeof o.content === "string") {
      resultText = o.content;
    } else if (o.content !== undefined) {
      resultText = toolResultTextFromUnknown(o.content);
    }
    if (resultText === undefined) {
      return;
    }
    const placeholderName = name.length > 0 ? name : "tool";
    byIdLastWins.set(id, {
      id,
      name: placeholderName,
      arguments: {},
      result: resultText,
    });
  });
  return Array.from(byIdLastWins.values());
}

/**
 * Merge streaming `tool_calls` with `tool_results` updates (by tool call id), preserving call order.
 */
export function mergeToolCallsWithResults(
  calls: ToolCall[],
  resultUpdates: ToolCall[],
): ToolCall[] {
  if (resultUpdates.length === 0) {
    return calls;
  }
  const byId = new Map<string, ToolCall>();
  const order: string[] = [];
  for (const c of calls) {
    if (!byId.has(c.id)) {
      order.push(c.id);
    }
    byId.set(c.id, { ...c });
  }
  for (const u of resultUpdates) {
    if (!byId.has(u.id)) {
      order.push(u.id);
    }
    const existing = byId.get(u.id);
    if (existing) {
      const keepArgs =
        u.arguments && Object.keys(u.arguments).length > 0
          ? u.arguments
          : existing.arguments;
      byId.set(u.id, {
        ...existing,
        ...u,
        name: u.name || existing.name,
        arguments: keepArgs,
        result: u.result !== undefined ? u.result : existing.result,
      });
    } else {
      byId.set(u.id, { ...u });
    }
  }
  return order.map((toolId) => byId.get(toolId)!);
}
