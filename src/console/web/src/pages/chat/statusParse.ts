import type { StreamChunk } from "../../api/types";
import { extractNanobotStatusContext } from "../../utils/nanobotStatusContext";
import type { NanobotContextUsage } from "./types";

/**
 * Pull the first balanced `{ ... }` object out of an arbitrary text blob.
 *
 * Used to recover a status JSON that some providers wrap in chatter (e.g.
 * "Here is the status: {...}"). Returns the substring including the braces,
 * or `null` if no balanced object is found.
 */
export function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Parse compact token count fragments such as "8k", "65k", "6744", "1.2M". */
export function parseCompactTokenCountFragment(token: string): number | null {
  const t = token.replace(/,/g, "").trim();
  if (!t) {
    return null;
  }
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([kKmM])?$/i);
  if (!m) {
    return null;
  }
  const n = Number.parseFloat(m[1]);
  if (!Number.isFinite(n)) {
    return null;
  }
  const suf = (m[2] ?? "").toLowerCase();
  if (suf === "k") {
    return Math.round(n * 1000);
  }
  if (suf === "m") {
    return Math.round(n * 1_000_000);
  }
  return Math.round(n);
}

/**
 * Parse the plain-text `/status` body that nanobot emits as `event: message`,
 * e.g. `📚 Context: 8k/65k (15% of input budget)`.
 */
export function parseNanobotStatusPlainText(
  raw: string,
): NanobotContextUsage | null {
  const lineMatch = /Context:\s*(\S+)\s*\/\s*(\S+)\s*\(\s*(\d+(?:\.\d+)?)\s*%/i.exec(
    raw,
  );
  if (!lineMatch) {
    return null;
  }
  const te = parseCompactTokenCountFragment(lineMatch[1]);
  const wt = parseCompactTokenCountFragment(lineMatch[2]);
  const pu = Number.parseFloat(lineMatch[3]);
  if (te === null || wt === null || !Number.isFinite(pu) || pu < 0) {
    return null;
  }
  return {
    tokens_estimate: te,
    window_total: wt,
    percent_used: pu,
  };
}

/**
 * Parse a `/status` JSON payload (with or without a fenced code block, with
 * or without surrounding chatter). Falls back to plain-text parsing when no
 * usable JSON object is recovered.
 */
export function parseNanobotStatusJson(
  raw: string,
): NanobotContextUsage | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  let text = trimmed;
  const fence = /^```(?:json)?\s*([\s\S]*?)```$/m.exec(trimmed);
  if (fence) {
    text = fence[1].trim();
  }
  const candidates = [text, extractFirstJsonObject(trimmed) ?? ""].filter(
    (s) => s.length > 0,
  );
  for (const candidate of candidates) {
    try {
      const data = JSON.parse(candidate) as Record<string, unknown>;
      const ctx = extractNanobotStatusContext(data);
      if (!ctx) {
        continue;
      }
      const te = ctx.tokens_estimate;
      const wt = ctx.window_total;
      const pu = ctx.percent_used;
      if (
        typeof te === "number" &&
        typeof wt === "number" &&
        typeof pu === "number"
      ) {
        return {
          tokens_estimate: te,
          window_total: wt,
          percent_used: pu,
        };
      }
    } catch {
      continue;
    }
  }
  return parseNanobotStatusPlainText(trimmed);
}

/**
 * Prefer explicit `content`, then console-WS `data` (string or
 * `{ text | content | message | body }`) so `chat_done` shows what the server
 * sent instead of falling back to a synthetic placeholder.
 */
export function resolveChatDonePrimaryText(chunk: StreamChunk): string {
  if (typeof chunk.content === "string" && chunk.content !== "") {
    return chunk.content;
  }
  const raw = (chunk as StreamChunk & { data?: unknown }).data;
  if (raw === undefined || raw === null) {
    return "";
  }
  if (typeof raw === "string") {
    return raw;
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    for (const key of ["text", "content", "message", "body"] as const) {
      const v = o[key];
      if (typeof v === "string" && v !== "") {
        return v;
      }
    }
  }
  return "";
}

/** Abbreviate token counts with K / M (e.g. 6744 → 6.7K, 1_200_000 → 1.2M). */
export function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${formatKmScaled(value / 1_000_000)}M`;
  }
  if (abs >= 1000) {
    return `${formatKmScaled(value / 1000)}K`;
  }
  return String(Math.round(value));
}

function formatKmScaled(scaled: number): string {
  if (scaled >= 100) {
    return String(Math.round(scaled));
  }
  const rounded = Math.round(scaled * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}
