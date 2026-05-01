import type { StreamChunk } from "../../api/types";
import {
  extractOpenPawletStatusContext,
} from "../../utils/openpawletStatusContext";
import type { OpenPawletContextUsage } from "./types";

/** Build usage from an already-parsed status JSON object (OpenPawlet `/status-json` `data`). */
export function parseOpenPawletStatusPayload(
  root: Record<string, unknown>,
): OpenPawletContextUsage | null {
  const ctx = extractOpenPawletStatusContext(root);
  if (!ctx) {
    return null;
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
 * Parse the plain-text `/status` body that OpenPawlet emits as `event: message`,
 * e.g. `📚 Context: 8k/65k (15% of input budget)`.
 */
export function parseOpenPawletStatusPlainText(
  raw: string,
): OpenPawletContextUsage | null {
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
 * Parse a single JSON text blob (e.g. trailing `chat_done` body). Expects the
 * wire payload to already be JSON — no markdown fences or substring recovery.
 */
export function parseOpenPawletStatusJson(
  raw: string,
): OpenPawletContextUsage | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    return parseOpenPawletStatusPayload(data);
  } catch {
    return null;
  }
}

/** Primary text segment on chunks that expose string `content`. */
export function streamChunkText(
  chunk: Pick<StreamChunk, "content">,
): string {
  return typeof chunk.content === "string" ? chunk.content : "";
}

/**
 * Prefer structured `openpawlet_status_payload`; otherwise one-shot `JSON.parse`
 * on string `content` (legacy frames).
 */
export function parseOpenPawletStatusFromChunk(
  chunk: Pick<StreamChunk, "openpawlet_status_payload" | "content">,
): OpenPawletContextUsage | null {
  const payload = chunk.openpawlet_status_payload;
  if (payload !== undefined) {
    return parseOpenPawletStatusPayload(payload);
  }
  return parseOpenPawletStatusJson(streamChunkText(chunk));
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
