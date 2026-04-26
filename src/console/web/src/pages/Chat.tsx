import {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { useParams, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import i18n from "../i18n";
import { useAppStore } from "../store";
import {
  disconnectNanobotChannelWebSocket,
  resolveNanobotWsBase,
  tryParseNanobotResumeChatId,
  useNanobotChannelWebSocket,
} from "../hooks/useNanobotChannelWebSocket";
import type { ChatChunkSource } from "../hooks/useWebSocket";
import { registerChatHandler, getWSRef } from "../hooks/useWebSocket";
import { useAgentTimeZone } from "../hooks/useAgentTimeZone";
import { formatChatMessageTime } from "../utils/agentDatetime";
import * as api from "../api/client";
import { Button, Tag, Popconfirm, Checkbox, Spin, Modal, Select, Tabs } from "antd";
import {
  PlusOutlined,
  LoadingOutlined,
  CheckOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
} from "@ant-design/icons";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Copy,
  MessageSquare,
  Sparkles,
  Square,
  Users,
  Wand2,
  Wrench,
  Info,
  X,
  FileText,
} from "lucide-react";
import type { SessionInfo, StreamChunk, ToolCall } from "../api/types";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { EditorView } from "@codemirror/view";
import { vscodeDark, vscodeLight } from "@uiw/codemirror-theme-vscode";
import { normalizeToolCallsArray } from "../utils/toolCalls";
import { extractNanobotStatusContext } from "../utils/nanobotStatusContext";
import type { TextAreaRef } from "antd/es/input/TextArea";
import Input from "antd/es/input";
import { SubagentPanel, type SubagentTask } from "../components/SubagentPanel";
import { MessageRow } from "./chat/MessageRow";
import { VirtualizedMessageList } from "./chat/VirtualizedMessageList";
import { useVirtualListHandle } from "./chat/useVirtualListHandle";

/**
 * Pagination window size for lazy-loaded chat history.
 *
 * The first request asks the backend `/transcript` endpoint for the most
 * recent `CHAT_HISTORY_PAGE_SIZE` messages; scrolling to the top fetches the
 * previous page. Keep this modest so the first render of a long conversation
 * stays fast; users scrolling up pay a single round-trip for older context.
 */
const CHAT_HISTORY_PAGE_SIZE = 80;

/** Pixel distance from the container's top that triggers a prev-page fetch. */
const CHAT_HISTORY_TOP_TRIGGER_PX = 120;

/** Near-bottom threshold (mirrors the pre-virtualization scroll sticky rule). */
const CHAT_NEAR_BOTTOM_PX = 100;

/** nanobot `/status` (or legacy JSON) → `context` slice (silent poll after each turn). */
interface NanobotContextUsage {
  tokens_estimate: number;
  window_total: number;
  percent_used: number;
}

function extractFirstJsonObject(text: string): string | null {
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

/** e.g. "8k", "65k", "6744", "1.2M" */
function parseCompactTokenCountFragment(token: string): number | null {
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
 * Plain-text `/status` body (nanobot `event: message` with `text`), e.g.
 * `📚 Context: 8k/65k (15% of input budget)`.
 */
function parseNanobotStatusPlainText(raw: string): NanobotContextUsage | null {
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

function parseNanobotStatusJson(raw: string): NanobotContextUsage | null {
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
 * Prefer explicit `content`, then console-WS `data` (string or { text | content | message | body }),
 * so `chat_done` shows what the server sent instead of falling back to a synthetic placeholder.
 */
function resolveChatDonePrimaryText(chunk: StreamChunk): string {
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
function formatCompactTokenCount(value: number): string {
  if (!Number.isFinite(value)) {
    return "—";
  }
  const abs = Math.abs(value);
  if (abs >= 1_000_000) {
    return `${_formatKmScaled(value / 1_000_000)}M`;
  }
  if (abs >= 1000) {
    return `${_formatKmScaled(value / 1000)}K`;
  }
  return String(Math.round(value));
}

function _formatKmScaled(scaled: number): string {
  if (scaled >= 100) {
    return String(Math.round(scaled));
  }
  const rounded = Math.round(scaled * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

interface ChatInputProps {
  inputRef: React.RefObject<TextAreaRef | null>;
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSend: () => void;
  onStop: () => void;
  isStreaming: boolean;
  showContextMeter: boolean;
  contextUsage: NanobotContextUsage | null;
  contextLoading: boolean;
}

function ChatInput({
  inputRef,
  value,
  onChange,
  onKeyDown,
  onSend,
  onStop,
  isStreaming,
  showContextMeter,
  contextUsage,
  contextLoading,
}: ChatInputProps) {
  const { t } = useTranslation();
  const [focused, setFocused] = useState(false);
  const canSend = value.trim().length > 0;

  return (
    <div className="space-y-2">
      <div
        className={`relative rounded-md border transition-all duration-200 bg-white dark:bg-gray-900 ${
          focused
            ? "border-blue-400 dark:border-blue-500 shadow-[0_0_0_3px_rgba(59,130,246,0.15)]"
            : "border-gray-200 dark:border-gray-700 shadow-sm hover:border-gray-300 dark:hover:border-gray-600"
        }`}
      >
        <Input.TextArea
          ref={inputRef as React.RefObject<TextAreaRef>}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t("chat.inputPlaceholder")}
          autoSize={{ minRows: 1, maxRows: 8 }}
          variant="borderless"
          className="!text-[15px] !leading-relaxed !py-3.5 !px-4 !pr-14 resize-none bg-transparent"
          style={{ boxShadow: "none" }}
        />

        {/* Action bar */}
        <div className="flex items-center justify-between gap-2 px-3 pb-2.5 pt-0">
          <span className="text-xs text-gray-400 dark:text-gray-500 select-none min-w-0 flex-1">
            {isStreaming ? (
              <span className="flex items-center gap-1.5 text-blue-500">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-500 animate-pulse" />
                {t("chat.generating")}
              </span>
            ) : (
              <span>{t("chat.inputHint")}</span>
            )}
          </span>

          <div className="flex items-center gap-2 shrink-0">
            {showContextMeter && (
              <div
                className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-gray-100/90 dark:bg-gray-800/90 border border-gray-200/80 dark:border-gray-600/80 text-[11px] tabular-nums text-gray-600 dark:text-gray-300 max-w-[min(100vw-8rem,14rem)]"
                title={t("chat.contextTooltip")}
              >
                {contextLoading ? (
                  <span className="flex items-center gap-1 text-gray-400">
                    <LoadingOutlined className="text-[10px]" />
                    {t("chat.contextLoading")}
                  </span>
                ) : contextUsage ? (
                  <span className="truncate">
                    {formatCompactTokenCount(contextUsage.tokens_estimate)} /{" "}
                    {formatCompactTokenCount(contextUsage.window_total)} ·{" "}
                    {Number.isInteger(contextUsage.percent_used)
                      ? contextUsage.percent_used
                      : contextUsage.percent_used.toFixed(1)}
                    %
                  </span>
                ) : (
                  <span className="text-gray-400">—</span>
                )}
              </div>
            )}

          <button
            onClick={isStreaming ? onStop : onSend}
            disabled={!isStreaming && !canSend}
            className={`flex items-center justify-center w-8 h-8 rounded-md transition-all duration-150 ${
              isStreaming
                ? "bg-red-500 hover:bg-red-600 text-white shadow-md shadow-red-500/30 hover:shadow-red-500/40 hover:scale-105"
                : canSend
                  ? "bg-blue-600 hover:bg-blue-700 text-white shadow-md shadow-blue-500/30 hover:shadow-blue-500/40 hover:scale-105"
                  : "bg-gray-100 dark:bg-gray-800 text-gray-400 dark:text-gray-600 cursor-not-allowed"
            }`}
            title={isStreaming ? t("chat.stop") : t("chat.send")}
          >
            {isStreaming ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <svg
                viewBox="0 0 16 16"
                className="w-3.5 h-3.5 fill-current"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path d="M.5 1.163A1 1 0 0 1 1.97.28l12.868 6.837a1 1 0 0 1 0 1.766L1.969 15.72A1 1 0 0 1 .5 14.836V10.33a1 1 0 0 1 .816-.983L8.5 8 1.316 6.653A1 1 0 0 1 .5 5.67V1.163Z" />
              </svg>
            )}
          </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface Message {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  isStreaming?: boolean;
  /** 发送时间，ISO 字符串，用于展示 */
  created_at?: string;
  timestamp?: string;
  /** 消息来源：user / main_agent / sub_agent / tool_call；聊天区仅展示 user 与 main_agent */
  source?: "user" | "main_agent" | "sub_agent" | "tool_call";
  /** WebSocket / 流式帧内嵌的多段工具调用，展示为可折叠块 */
  tool_calls?: ToolCall[];
  /** 发起工具调用前的推理说明 */
  reasoning_content?: string;
  /** Anthropic extended thinking blocks persisted in transcript JSONL. */
  thinking_blocks?: Array<Record<string, unknown>>;
  /**
   * UUID identifying the entire assistant reply for this user turn.
   * Comes from the server (transcript JSONL or WS frame). When absent we
   * fall back to a deterministic client-side hash; see `groupAssistantReplies`.
   */
  reply_group_id?: string;
}

/** Console WebSocket 的 tool_call / tool_result 追踪用（与帧内嵌 tool_calls 分列） */
interface TrackedToolCall {
  id: string;
  name: string;
  args: string;
  status: "pending" | "running" | "success" | "error";
  result?: string;
}

/** 将 Agent 的 tool_hint 拆成多行，避免 read_file("a")read_file("b") 挤在一行 */
function formatToolHintMultiline(hint: string): string {
  return hint.replace(/\),\s*(?=[A-Za-z_]\w*\()/g, ")\n");
}

/** JSON.stringify length heuristic for merging streaming tool call argument snapshots. */
function toolCallArgumentsPayloadScore(args: Record<string, unknown>): number {
  try {
    return JSON.stringify(args).length;
  } catch {
    return 0;
  }
}

/**
 * Merge successive chat_token / tool_event batches: keep prior tool calls and
 * append new ids; for the same id, prefer richer arguments and latest result.
 * (Nanobot often sends one batch per tool round — the old implementation only
 * returned `incoming.length` entries and dropped earlier calls.)
 */
function mergeStreamingToolCalls(prev: ToolCall[], incoming: ToolCall[]): ToolCall[] {
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
 * Safe display for tool arguments. JSON.stringify(undefined) is undefined and
 * renders nothing in React — avoid empty expanded panels.
 */
function formatToolCallArgumentsForDisplay(
  args: Record<string, unknown> | undefined,
): string {
  if (args === undefined) {
    return i18n.t("chat.argumentsMissing");
  }
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

function toolCallSummaryPreview(
  args: Record<string, unknown> | undefined,
): string | null {
  if (!args || Object.keys(args).length === 0) {
    return null;
  }
  for (const v of Object.values(args)) {
    if (typeof v === "string" && v.trim()) {
      const t = v.trim();
      return t.length > 52 ? `${t.slice(0, 49)}…` : t;
    }
  }
  return null;
}

function ArgumentValueNode({ value }: { value: unknown }): ReactNode {
  if (value === null) {
    return (
      <span className="text-slate-400 dark:text-slate-500">
        {i18n.t("chat.jsonNull")}
      </span>
    );
  }
  if (typeof value === "boolean") {
    return (
      <code className="text-slate-700 dark:text-slate-200">{String(value)}</code>
    );
  }
  if (typeof value === "number") {
    return <code className="text-slate-700 dark:text-slate-200">{value}</code>;
  }
  if (typeof value === "string") {
    const multiline = value.includes("\n") || value.length > 160;
    if (multiline) {
      return (
        <pre className="text-[11px] sm:text-xs font-mono leading-relaxed m-0 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200 bg-slate-100/80 dark:bg-slate-900/50 rounded px-2.5 py-2 ring-1 ring-inset ring-slate-200/70 dark:ring-slate-600/45">
          {value}
        </pre>
      );
    }
    return (
      <span className="break-words text-slate-800 dark:text-slate-200">
        &quot;{value}&quot;
      </span>
    );
  }
  return (
    <pre className="text-[11px] font-mono leading-relaxed m-0 whitespace-pre-wrap break-words text-slate-600 dark:text-slate-400">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function ToolCallParametersTable({
  args,
}: {
  args: Record<string, unknown>;
}) {
  const { t } = useTranslation();
  const internalKeys = new Set(["_raw", "_value"]);
  const primary = Object.entries(args).filter(([k]) => !internalKeys.has(k));
  const internal = Object.entries(args).filter(([k]) => internalKeys.has(k));

  if (primary.length === 0 && internal.length === 0) {
    return (
      <p className="text-[12px] text-slate-500 dark:text-slate-400 m-0">
        {t("chat.noArguments")}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {primary.length > 0 ? (
        <dl className="space-y-2.5 m-0">
          {primary.map(([key, value]) => (
            <div
              key={key}
              className="grid grid-cols-1 sm:grid-cols-[minmax(0,9rem)_1fr] gap-x-3 gap-y-1 text-[12px] sm:text-[13px] leading-snug"
            >
              <dt className="text-slate-500 dark:text-slate-400 font-medium shrink-0 pt-0.5">
                {key}
              </dt>
              <dd className="min-w-0 m-0">
                <ArgumentValueNode value={value} />
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      {internal.length > 0 ? (
        <div className="rounded-md bg-amber-50/90 dark:bg-amber-950/25 ring-1 ring-amber-200/80 dark:ring-amber-800/45 px-3 py-2 space-y-2">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-amber-800/90 dark:text-amber-200/85">
            {t("chat.partialPayload")}
          </div>
          {internal.map(([key, value]) => (
            <div key={key}>
              <div className="text-[11px] text-amber-900/80 dark:text-amber-100/75 mb-1 font-mono">
                {key}
              </div>
              <ArgumentValueNode value={value} />
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ToolCallIdCopy({ callId }: { callId: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(() => {
    void navigator.clipboard.writeText(callId).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    });
  }, [callId]);

  return (
    <div className="flex items-center gap-1.5 min-w-0 justify-end">
      <code
        className="text-[11px] font-mono text-slate-600 dark:text-slate-300 truncate max-w-[min(100%,14rem)] sm:max-w-xs"
        title={callId}
      >
        {callId}
      </code>
      <button
        type="button"
        onClick={onCopy}
        className="shrink-0 rounded p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200/60 dark:hover:bg-white/10 dark:hover:text-slate-200 transition-colors"
        title={t("chat.copyCallId")}
        aria-label={t("chat.copyCallId")}
      >
        {copied ? (
          <Check
            className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
            strokeWidth={2.5}
          />
        ) : (
          <Copy className="h-3.5 w-3.5" strokeWidth={2} />
        )}
      </button>
    </div>
  );
}

/** `reasoning_content`：折叠展示在正文上方，标题为 Thinking */
/**
 * Walk messages in order: for each `role === "tool"` with `tool_call_id`, set
 * `result` on the matching entry in the nearest preceding assistant
 * `tool_calls`. Those tool messages are omitted from the output; unmatched
 * tool rows are kept.
 */
function mergeToolResultsIntoAssistantMessages(messages: Message[]): Message[] {
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

function extractReasoningFromThinkingBlocks(
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

function normalizeMessageForChatRender(msg: Message): Message {
  const normalizedToolCalls = normalizeToolCallsArray(
    msg.tool_calls as unknown,
  );
  const normalizedReasoning =
    typeof msg.reasoning_content === "string" && msg.reasoning_content.trim()
      ? msg.reasoning_content
      : extractReasoningFromThinkingBlocks(msg.thinking_blocks);
  const normalizedSource =
    msg.source ??
    (msg.role === "user"
      ? "user"
      : msg.role === "assistant"
        ? "main_agent"
        : undefined);
  return {
    ...msg,
    content: typeof msg.content === "string" ? msg.content : String(msg.content ?? ""),
    source: normalizedSource,
    ...(normalizedToolCalls.length > 0 ? { tool_calls: normalizedToolCalls } : {}),
    ...(normalizedReasoning ? { reasoning_content: normalizedReasoning } : {}),
  };
}

function appendReplySection(base: string, incoming: string): string {
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
 * We use a hand-rolled FNV-1a + xorshift mixer instead of crypto.subtle so the
 * function stays synchronous and works under React render. Collisions are
 * astronomically unlikely for the input space (anchor + role + ts + content
 * head) and the result is purely client-side, so it does not need to match
 * RFC 4122 cryptographically — the goal is a stable React key + group id.
 */
function hashStringToUuid(input: string): string {
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
 * The same anchor produces the same UUID on transcript replay and WS streaming,
 * which is what keeps the rendered "group" stable across the two transports.
 */
function buildReplyGroupUuid(anchor: Message): string {
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
function resolveAssistantGroupId(msg: Message): string {
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
function buildAssistantGroupRowId(msg: Message, groupId: string): string {
  const anchorSeed = [
    msg.id || "",
    msg.created_at || msg.timestamp || "",
    (msg.content || "").slice(0, 64),
  ].join("|");
  return `grp-${groupId}-${hashStringToUuid(anchorSeed)}`;
}

function groupAssistantReplies(messages: Message[]): Message[] {
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

function MessageThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return (
    <details className="group text-left rounded-md overflow-hidden bg-gradient-to-br from-slate-50/95 to-slate-100/40 dark:from-slate-800/35 dark:to-slate-900/25 ring-1 ring-slate-200/70 dark:ring-slate-600/40 border-l-[3px] border-l-primary-500/85 dark:border-l-primary-400/70 shadow-sm shadow-slate-900/5">
      <summary className="cursor-pointer list-none flex items-center gap-2.5 px-3.5 py-2.5 [&::-webkit-details-marker]:hidden select-none hover:bg-slate-100/60 dark:hover:bg-white/[0.04] transition-colors">
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500 transition-transform duration-200 group-open:rotate-90"
          aria-hidden
          strokeWidth={2.25}
        />
        <Sparkles
          className="h-3.5 w-3.5 shrink-0 text-primary-600 dark:text-primary-400 opacity-90"
          aria-hidden
          strokeWidth={2}
        />
        <span className="text-[13px] font-medium text-slate-600 dark:text-slate-300 tracking-tight">
          {t("chat.thinking")}
        </span>
      </summary>
      <div className="px-3.5 pb-3.5 pt-0">
        <div className="border-t border-slate-200/55 dark:border-slate-600/35 pt-2.5">
          <div className="text-[13px] leading-relaxed text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words max-h-56 overflow-y-auto pr-0.5">
            {trimmed}
          </div>
        </div>
      </div>
    </details>
  );
}

function MessageToolCallsBlock({
  tool_calls,
  noTopMargin,
}: {
  tool_calls?: ToolCall[];
  /** 外层已有分隔/间距时置为 true，避免重复上边距 */
  noTopMargin?: boolean;
}) {
  const { t } = useTranslation();
  const normalizedList = useMemo(() => {
    const list = tool_calls ?? [];
    return normalizeToolCallsArray(list as unknown);
  }, [tool_calls]);

  if (normalizedList.length === 0) {
    return null;
  }

  return (
    <div className={`${noTopMargin ? "" : "mt-3"} space-y-2.5`}>
      <div className="flex items-center gap-2 pl-0.5">
        <Wrench
          className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500 shrink-0"
          strokeWidth={2}
          aria-hidden
        />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
          {t("chat.toolCalls")}
        </span>
      </div>
      <div className="space-y-2">
        {normalizedList.map((tc) => {
          const preview = toolCallSummaryPreview(tc.arguments);
          return (
            <details
              key={tc.id}
              className="group rounded-md text-left bg-white/90 dark:bg-gray-900/45 ring-1 ring-slate-200/80 dark:ring-slate-700/55 shadow-sm shadow-slate-900/[0.04] dark:shadow-black/20"
            >
              <summary className="cursor-pointer list-none flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3 py-2.5 [&::-webkit-details-marker]:hidden hover:bg-slate-50/90 dark:hover:bg-white/[0.04] transition-colors rounded-md">
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 text-slate-400 dark:text-slate-500 transition-transform duration-200 group-open:rotate-90"
                  aria-hidden
                  strokeWidth={2.25}
                />
                <span
                  className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-slate-200/90 text-slate-600 dark:bg-slate-700/90 dark:text-slate-300"
                  title={t("chat.toolCallType")}
                >
                  {tc.tool_call_type ?? "function"}
                </span>
                <code className="text-[12px] sm:text-[13px] font-mono font-semibold text-slate-800 dark:text-slate-100 break-all leading-snug">
                  {tc.name}
                </code>
                {tc.result !== undefined ? (
                  <span
                    className="inline-flex shrink-0"
                    title={t("chat.toolCompleted")}
                    aria-label={t("chat.toolCompleted")}
                  >
                    <CheckCircle2
                      className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400"
                      strokeWidth={2.25}
                      aria-hidden
                    />
                  </span>
                ) : null}
                {preview ? (
                  <span
                    className="w-full sm:w-auto sm:flex-1 sm:min-w-0 text-[11px] text-slate-400 dark:text-slate-500 sm:text-right truncate pl-6 sm:pl-0"
                    title={preview}
                  >
                    · {preview}
                  </span>
                ) : null}
              </summary>
              <div className="px-3 pb-3 pt-0 border-t border-slate-200/55 dark:border-slate-600/35">
                <div className="pt-3 space-y-3">
                  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 shrink-0">
                      {t("chat.callId")}
                    </span>
                    <ToolCallIdCopy callId={tc.id} />
                  </div>
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                      {t("chat.parameters")}
                    </div>
                    <ToolCallParametersTable args={tc.arguments} />
                  </div>
                  {tc.result !== undefined ? (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500 mb-2">
                        {t("chat.result")}
                      </div>
                      <pre className="text-[11px] sm:text-xs font-mono leading-relaxed m-0 whitespace-pre-wrap break-words text-slate-700 dark:text-slate-200 bg-emerald-50/80 dark:bg-emerald-950/35 rounded px-2.5 py-2 ring-1 ring-inset ring-emerald-200/70 dark:ring-emerald-800/45 max-h-56 overflow-y-auto">
                        {tc.result || "(empty)"}
                      </pre>
                    </div>
                  ) : null}
                  <details className="group/json rounded-md ring-1 ring-slate-200/65 dark:ring-slate-600/45 bg-slate-50/60 dark:bg-slate-950/40">
                    <summary className="cursor-pointer list-none px-3 py-2 text-[11px] font-medium text-slate-500 dark:text-slate-400 [&::-webkit-details-marker]:hidden hover:bg-slate-100/70 dark:hover:bg-white/[0.05] rounded-md transition-colors">
                      {t("chat.rawJson")}
                    </summary>
                    <pre className="text-[11px] sm:text-xs font-mono leading-relaxed text-slate-600 dark:text-slate-400 px-3 pb-3 pt-0 m-0 overflow-x-auto whitespace-pre-wrap break-words">
                      {formatToolCallArgumentsForDisplay(tc.arguments)}
                    </pre>
                  </details>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Canonical "last activity" timestamp for a session (newer = larger).
 * Prefers `updated_at` (when any message moved the row) and falls back to
 * `created_at` so freshly created empty rows still compare deterministically.
 *
 * This is the single source of truth for "which session is newest" across
 * the chat page (sidebar highlight/scroll, bare-route bootstrap, delete
 * fallback, 404 recovery). Keeping one rule avoids the UI picking row A in
 * the sidebar while navigation / fallback jumps to row B.
 */
function sessionInfoLastActiveMs(info: SessionInfo): number {
  const raw = info.updated_at ?? info.created_at;
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pick the session row with the newest last-activity timestamp (see `sessionInfoLastActiveMs`). */
function pickLatestActiveSessionKey(rows: SessionInfo[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  let best = rows[0];
  let bestMs = sessionInfoLastActiveMs(best);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ms = sessionInfoLastActiveMs(row);
    if (ms >= bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  return best.key;
}

/** Pretty-print each JSONL line; copy still uses raw file text from the API. */
function formatJsonlForDisplay(raw: string): string {
  const lines = raw.split("\n");
  const blocks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const obj: unknown = JSON.parse(trimmed);
      blocks.push(JSON.stringify(obj, null, 2));
    } catch {
      blocks.push(line);
    }
  }
  return blocks.join("\n\n");
}

/** True when GET /sessions/:key/transcript failed because the session does not exist. */
function isSessionMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return /\b404\b/.test(msg) || /not\s*found/i.test(msg);
}

/** Persist last open session so a bare `/chat` reload can return to it. */
const LAST_CONSOLE_SESSION_STORAGE_KEY = "console_last_session_key";

/**
 * Set from "New chat" so we do not auto-open an existing row while sessions
 * still exist (see bare-route bootstrap).
 */
const NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY = "nanobot_chat_new_intent";

function readNanobotChatNewIntent(): boolean {
  try {
    return sessionStorage.getItem(NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export default function Chat() {
  const { t, i18n } = useTranslation();
  const { sessionKey: paramSessionKey } = useParams();
  const resumeNanobotChatUuid = useMemo(
    () => tryParseNanobotResumeChatId(paramSessionKey),
    [paramSessionKey],
  );
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { currentSessionKey, setCurrentSessionKey, currentBotId, addToast } =
    useAppStore();
  const nanobotClientId = useAppStore((s) => s.nanobotClientId);
  const agentTz = useAgentTimeZone();

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const isStreamingRef = useRef(false);
  /** True when `isStreaming` was set from nanobot WS `ready.session_busy` (turn in flight on server). */
  const streamingPrimedByServerRef = useRef(false);
  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);
  /** One assistant reply per user turn; drop duplicate chat_done (e.g. stream_end + chat_end). */
  const assistantReplyFinalizedRef = useRef(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(false);
  const [sessionsSidebarCollapsed, setSessionsSidebarCollapsed] =
    useState(false);
  const [sessionTreeExpanded, setSessionTreeExpanded] = useState({
    main: true,
    teams: false,
  });
  const [batchSelectedKeys, setBatchSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [toolCalls, setToolCalls] = useState<TrackedToolCall[]>([]);
  /** nanobot WebSocket 帧中的 tool_calls / reasoning_content（与正文并行展示） */
  const [streamingPayloadToolCalls, setStreamingPayloadToolCalls] = useState<
    ToolCall[]
  >([]);
  const [streamingReasoningContent, setStreamingReasoningContent] =
    useState<string>("");
  const streamingPayloadToolCallsRef = useRef<ToolCall[]>([]);
  const streamingReasoningContentRef = useRef<string>("");
  /**
   * Server-issued reply_group_id observed on the current streaming turn.
   * The runtime stamps this UUID on every WS frame for one Agent reply, so
   * we keep the first non-empty value seen and apply it to the assistant
   * bubble we materialize on chat_done. Reset on chat_done / new turn.
   */
  const streamingReplyGroupIdRef = useRef<string | null>(null);
  /** 流式过程中后端单独下发的工具调用摘要（与正文 Markdown 分离） */
  const [streamingToolProgress, setStreamingToolProgress] = useState<string[]>(
    [],
  );
  /** nanobot `event: message` (retries, status) until `chat_end` */
  const [streamingChannelNotices, setStreamingChannelNotices] = useState<
    string[]
  >([]);
  const [showSuggestions, setShowSuggestions] = useState(true);
  const [subagentTasks, setSubagentTasks] = useState<SubagentTask[]>([]);
  const [subagentPanelOpen, setSubagentPanelOpen] = useState(true);
  const [sessionJsonlModalOpen, setSessionJsonlModalOpen] = useState(false);
  const [renameSessionModalOpen, setRenameSessionModalOpen] = useState(false);
  const [renameSessionKey, setRenameSessionKey] = useState<string | null>(null);
  const [renameSessionTitle, setRenameSessionTitle] = useState("");
  const [sessionJsonlFileSource, setSessionJsonlFileSource] = useState<
    "session" | "transcript"
  >("session");
  const [sessionContextTab, setSessionContextTab] = useState<
    "assembled" | "raw"
  >("assembled");
  const jsonlViewTheme = useAppStore((s) => s.theme);
  const [codeMirrorIsDark, setCodeMirrorIsDark] = useState(false);
  useEffect(() => {
    if (jsonlViewTheme === "light") {
      setCodeMirrorIsDark(false);
      return;
    }
    if (jsonlViewTheme === "dark") {
      setCodeMirrorIsDark(true);
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    setCodeMirrorIsDark(mq.matches);
    const onChange = () => setCodeMirrorIsDark(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [jsonlViewTheme]);
  const [nanobotContextUsage, setNanobotContextUsage] =
    useState<NanobotContextUsage | null>(null);
  const [statusJsonLoading, setStatusJsonLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  /** When false, new tokens must not force scroll (user scrolled up to read). */
  const messagesStickToBottomRef = useRef(true);
  /** Imperative handle into the virtualized message list (scroll helpers). */
  const [virtualListHandleRef, setVirtualListHandle] = useVirtualListHandle();
  /** Tracks unseen new-message count while the user is scrolled away from the bottom. */
  const [unreadBelowCount, setUnreadBelowCount] = useState(0);
  /** Drives the "jump to bottom" button visibility; updated from scroll events. */
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  /**
   * Absolute index (into the full transcript) of the oldest message currently
   * loaded in `messages`. `null` when pagination metadata is unavailable
   * (transcript endpoint returned the legacy full-history shape).
   */
  const [historyOldestOffset, setHistoryOldestOffset] = useState<number | null>(
    null,
  );
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  /** Prevent concurrent prev-page requests for the same scroll event burst. */
  const loadingOlderRef = useRef(false);
  const inputRef = useRef<TextAreaRef>(null);
  const streamingContentRef = useRef("");
  /** Coalesce high-frequency chat_token updates to one setState per animation frame */
  const streamTokenFlushRafRef = useRef<number | null>(null);
  const pendingStreamTokenDeltaRef = useRef("");
  /** Throttle transcript refetch triggered by in-flight tool events. */
  const transcriptSyncTimerRef = useRef<number | null>(null);
  /** 新会话首条消息：等待 nanobot 内置 websocket 通道连接后再发送 */
  const pendingNanobotOutboundRef = useRef<string | null>(null);
  /** Silent `/status` poll: ignore streamed UI, parse status payload only */
  const silentStatusJsonRef = useRef(false);
  const silentStatusJsonBufferRef = useRef("");
  const statusJsonInFlightRef = useRef(false);
  const queuedStatusJsonRef = useRef(false);
  /** Incremented when `activeSessionKey` changes so stale `/status` replies are ignored */
  const contextSessionEpochRef = useRef(0);
  const statusJsonPollEpochRef = useRef(0);
  /** After early parse from `/status`, ignore a following empty `chat_end` frame */
  const expectStatusJsonTrailingChatDoneRef = useRef(false);

  /** Cancel scheduled rAF and apply any buffered tokens so state matches streamingContentRef */
  const cancelStreamTokenFlush = useCallback(() => {
    if (streamTokenFlushRafRef.current !== null) {
      cancelAnimationFrame(streamTokenFlushRafRef.current);
      streamTokenFlushRafRef.current = null;
    }
    const delta = pendingStreamTokenDeltaRef.current;
    pendingStreamTokenDeltaRef.current = "";
    if (delta) {
      setStreamingContent((prev) => prev + delta);
    }
  }, []);

  const cancelTranscriptSync = useCallback(() => {
    if (transcriptSyncTimerRef.current !== null) {
      window.clearTimeout(transcriptSyncTimerRef.current);
      transcriptSyncTimerRef.current = null;
    }
  }, []);

  const activeSessionKey = paramSessionKey || currentSessionKey;

  /**
   * Throttled transcript refetch triggered by inflight tool events. Backend now
   * appends tool_calls / tool results to the transcript immediately, so pulling
   * `/sessions/:key/transcript` mid-turn surfaces them without waiting for
   * `chat_done`. Coalesces bursts to at most one refetch per 1.5s.
   */
  const scheduleTranscriptSync = useCallback(() => {
    if (!activeSessionKey) {
      return;
    }
    if (transcriptSyncTimerRef.current !== null) {
      return;
    }
    transcriptSyncTimerRef.current = window.setTimeout(() => {
      transcriptSyncTimerRef.current = null;
      queryClient.invalidateQueries({
        queryKey: ["session", activeSessionKey, currentBotId],
      });
    }, 1500);
  }, [activeSessionKey, currentBotId, queryClient]);

  useEffect(() => {
    contextSessionEpochRef.current += 1;
    setNanobotContextUsage(null);
    silentStatusJsonRef.current = false;
    silentStatusJsonBufferRef.current = "";
    statusJsonInFlightRef.current = false;
    queuedStatusJsonRef.current = false;
    setStatusJsonLoading(false);
    expectStatusJsonTrailingChatDoneRef.current = false;
    messagesStickToBottomRef.current = true;
  }, [activeSessionKey]);

  useEffect(() => {
    streamingPrimedByServerRef.current = false;
  }, [activeSessionKey]);

  const nanobotWsBase = resolveNanobotWsBase();
  const useNanobotChannel = nanobotWsBase.length > 0;

  const {
    data: sessions,
    isPending: sessionsListPending,
    isError: sessionsListError,
  } = useQuery({
    queryKey: ["sessions", currentBotId],
    queryFn: () => api.listSessions(currentBotId),
  });

  useEffect(() => {
    if (!sessions?.length) {
      setBatchSelectedKeys((prev) => (prev.size === 0 ? prev : new Set()));
      return;
    }
    const validKeys = new Set(sessions.map((s) => s.key));
    setBatchSelectedKeys((prev) => {
      const next = new Set([...prev].filter((k) => validKeys.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [sessions]);

  const onBareNanobotChatRoute =
    useNanobotChannel && paramSessionKey === undefined;
  // Bare `/chat` should not eagerly open a WebSocket: doing so makes the
  // nanobot agent loop materialize an in-memory Session on the very first
  // `/status` poll triggered after `ready`, which the SessionManager later
  // flushes to disk as an empty `sessions/*.jsonl` file (visible as a
  // ghost row in the sidebar after every backend restart). Only connect
  // when the user has explicitly opted into a new chat or when an
  // existing route is being resumed (`/chat/:key`).
  const nanobotChannelWsEnabled =
    useNanobotChannel &&
    (!onBareNanobotChatRoute ||
      (!sessionsListPending &&
        (sessionsListError || readNanobotChatNewIntent())));

  useEffect(() => {
    if (paramSessionKey === undefined) {
      return;
    }
    try {
      sessionStorage.removeItem(NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY);
    } catch {
      // ignore
    }
  }, [paramSessionKey]);

  useEffect(() => {
    if (!useNanobotChannel) {
      return;
    }
    const routeKey = paramSessionKey?.trim();
    if (routeKey) {
      useAppStore.getState().setNanobotClientId(routeKey);
    }
  }, [useNanobotChannel, paramSessionKey]);

  /**
   * After the session list loads, open the last-opened session if still present;
   * otherwise the newest-created row in the list. Skip when starting a blank
   * "New chat" (storage flag) or when there are no sessions (new WS chat).
   */
  useEffect(() => {
    if (!useNanobotChannel) {
      return;
    }
    if (paramSessionKey !== undefined) {
      return;
    }
    if (sessionsListPending || sessionsListError) {
      return;
    }
    const list = sessions ?? [];
    if (list.length === 0) {
      return;
    }
    if (readNanobotChatNewIntent()) {
      return;
    }
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
    } catch {
      return;
    }
    const storedKey = stored?.trim() ?? "";
    const keys = new Set(list.map((row) => row.key));
    const fallback = pickLatestActiveSessionKey(list);
    if (!fallback) {
      return;
    }
    const pick =
      storedKey.length > 0 && keys.has(storedKey) ? storedKey : fallback;
    navigate(`/chat/${encodeURIComponent(pick)}`, { replace: true });
  }, [
    useNanobotChannel,
    paramSessionKey,
    sessionsListPending,
    sessionsListError,
    sessions,
    navigate,
  ]);

  useEffect(() => {
    if (!useNanobotChannel || !activeSessionKey) {
      return;
    }
    const key = activeSessionKey.trim();
    if (!key) {
      return;
    }
    try {
      localStorage.setItem(LAST_CONSOLE_SESSION_STORAGE_KEY, key);
    } catch {
      // ignore quota / private mode
    }
  }, [useNanobotChannel, activeSessionKey]);

  /**
   * Bare `/chat` draft -> real session activation marker.
   * We only materialize a new session after the first outbound message, instead
   * of on socket `ready`, to match mainstream chat UX and avoid empty sessions.
   */
  const draftSessionActivationRequestedRef = useRef(false);
  const [draftSessionActivationTick, setDraftSessionActivationTick] = useState(0);

  /**
   * After deleting the current session, `navigate` is async while `useParams` still
   * holds the old key briefly; `activeSessionKey` would still match the deleted id
   * and trigger GET /sessions/:key/transcript → 404. Suppress history fetch until the route
   * param leaves that key.
   */
  const suppressSessionDetailForKeyRef = useRef<string | null>(null);
  /** Dedupe `createSession` + list invalidation when route/store deps churn with the same logical session. */
  const ensuredNanobotConsoleSessionRef = useRef<string | null>(null);

  const onNanobotReadySessionBusy = useCallback((busy: boolean) => {
    if (busy) {
      streamingPrimedByServerRef.current = true;
      setIsStreaming(true);
    } else if (streamingPrimedByServerRef.current) {
      streamingPrimedByServerRef.current = false;
      setIsStreaming(false);
    }
  }, []);

  const { sendMessage: sendNanobotMessage, ready: nanobotWsReady } =
    useNanobotChannelWebSocket({
      enabled: nanobotChannelWsEnabled,
      canonicalSessionKeyFromRoute: paramSessionKey ?? null,
      resumeChatId: resumeNanobotChatUuid,
      onReadySessionBusy: useNanobotChannel ? onNanobotReadySessionBusy : undefined,
    });

  /**
   * nanobot `ready` 后由 `chat_id` 派生会话键 `websocket:<chat_id>`（见 `nanobotSessionKeyFromReadyChatId`）。
   * 仅在“用户已经发送过首条消息（草稿激活）+ 当前仍处 `/chat` 草稿态”时建立控制台
   * `sessions/*.jsonl` 并把路由同步为该键。这样可以避免 ws 重连/ready 抖动反复
   * 触发新会话，主流聊天产品的“首条消息落地一个会话”行为。
   */
  useEffect(() => {
    if (!useNanobotChannel || !nanobotClientId) {
      ensuredNanobotConsoleSessionRef.current = null;
      return;
    }
    if (!draftSessionActivationRequestedRef.current) {
      return;
    }
    if (paramSessionKey !== undefined) {
      // Already on /chat/:key — do not POST /sessions again, the file already
      // exists for this thread. Clear the activation marker so subsequent
      // ready frames are ignored.
      draftSessionActivationRequestedRef.current = false;
      return;
    }

    const dedupeKey = `${String(currentBotId ?? "")}:${nanobotClientId}`;
    if (ensuredNanobotConsoleSessionRef.current === dedupeKey) {
      return;
    }
    ensuredNanobotConsoleSessionRef.current = dedupeKey;

    void api
      .createSession(nanobotClientId, currentBotId)
      .then(() => {
        draftSessionActivationRequestedRef.current = false;
        queryClient.invalidateQueries({
          queryKey: ["sessions", currentBotId],
        });
        setCurrentSessionKey(nanobotClientId);
        navigate(`/chat/${encodeURIComponent(nanobotClientId)}`, {
          replace: true,
        });
        try {
          sessionStorage.removeItem(NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY);
        } catch {
          // ignore
        }
      })
      .catch((err) => {
        ensuredNanobotConsoleSessionRef.current = null;
        console.error("[chat] createSession after first outbound", err);
      });
  }, [
    useNanobotChannel,
    nanobotClientId,
    currentBotId,
    paramSessionKey,
    navigate,
    setCurrentSessionKey,
    queryClient,
    draftSessionActivationTick,
  ]);

  const scheduleNanobotStatusJson = useCallback(() => {
    if (!useNanobotChannel || !nanobotWsReady) {
      return;
    }
    if (statusJsonInFlightRef.current) {
      queuedStatusJsonRef.current = true;
      return;
    }
    statusJsonInFlightRef.current = true;
    silentStatusJsonRef.current = true;
    silentStatusJsonBufferRef.current = "";
    statusJsonPollEpochRef.current = contextSessionEpochRef.current;
    setStatusJsonLoading(true);
    try {
      sendNanobotMessage({
        content: "/status-json",
        botId: currentBotId,
      });
    } catch {
      statusJsonInFlightRef.current = false;
      silentStatusJsonRef.current = false;
      setStatusJsonLoading(false);
      if (queuedStatusJsonRef.current) {
        queuedStatusJsonRef.current = false;
        queueMicrotask(() => scheduleNanobotStatusJson());
      }
    }
  }, [useNanobotChannel, nanobotWsReady, currentBotId, sendNanobotMessage]);

  const completeSilentStatusJsonPoll = useCallback(
    (raw: string, options?: { fromEarlyParse?: boolean }) => {
      const epochOk =
        statusJsonPollEpochRef.current === contextSessionEpochRef.current;
      silentStatusJsonBufferRef.current = "";
      silentStatusJsonRef.current = false;
      statusJsonInFlightRef.current = false;
      setStatusJsonLoading(false);
      if (options?.fromEarlyParse) {
        expectStatusJsonTrailingChatDoneRef.current = true;
      }
      if (epochOk) {
        const parsed = parseNanobotStatusJson(raw);
        if (parsed) {
          setNanobotContextUsage(parsed);
        }
      }
      if (queuedStatusJsonRef.current) {
        queuedStatusJsonRef.current = false;
        queueMicrotask(() => scheduleNanobotStatusJson());
      }
    },
    [scheduleNanobotStatusJson],
  );

  /** Sidebar's "latest" row uses the same rule as navigation/delete fallbacks. */
  const latestSessionKeyForSidebar = useMemo(
    () => pickLatestActiveSessionKey(sessions ?? []),
    [sessions],
  );
  const groupedSessions = useMemo(() => {
    const list = sessions ?? [];
    return {
      main: list.filter((sessionRow) => !sessionRow.team_id),
      teams: list.filter((sessionRow) => Boolean(sessionRow.team_id)),
    };
  }, [sessions]);

  const sessionSidebarRowRefs = useRef<Map<string, HTMLDivElement | null>>(
    new Map(),
  );
  const newChatSidebarScrollUntilRef = useRef(0);
  const [newChatSidebarScrollToken, setNewChatSidebarScrollToken] =
    useState(0);

  useEffect(() => {
    const until = newChatSidebarScrollUntilRef.current;
    if (!until || Date.now() > until) {
      return;
    }
    if (!sessions?.length) {
      return;
    }
    if (!sessionsSidebarOpen) {
      return;
    }
    if (sessionsSidebarCollapsed) {
      return;
    }

    const targetKey =
      nanobotClientId &&
      sessions.some((sessionRow) => sessionRow.key === nanobotClientId)
        ? nanobotClientId
        : latestSessionKeyForSidebar;
    if (!targetKey) {
      return;
    }

    const rowEl = sessionSidebarRowRefs.current.get(targetKey);
    if (!rowEl) {
      return;
    }

    const timer = window.setTimeout(() => {
      rowEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }, 320);

    return () => window.clearTimeout(timer);
  }, [
    sessions,
    nanobotClientId,
    latestSessionKeyForSidebar,
    sessionsSidebarOpen,
    sessionsSidebarCollapsed,
    newChatSidebarScrollToken,
  ]);

  const deleteSessionMutation = useMutation({
    mutationFn: async (key: string) => {
      const isDeletingCurrent = activeSessionKey === key;

      if (isDeletingCurrent) {
        /**
         * Required order for nanobot:
         * 1) Hard-close WS so no `ready` is processed for the session being removed.
         * 2) flushSync + navigate to the next session (or bare /chat).
         * 3) DELETE the jsonl on the server.
         */
        if (useNanobotChannel) {
          disconnectNanobotChannelWebSocket();
        }
        suppressSessionDetailForKeyRef.current = key;
        void queryClient.cancelQueries({
          queryKey: ["session", key, currentBotId],
        });
        queryClient.removeQueries({
          queryKey: ["session", key, currentBotId],
        });

        const list =
          queryClient.getQueryData<SessionInfo[]>([
            "sessions",
            currentBotId,
          ]) ?? [];
        const remaining = list.filter((row) => row.key !== key);
        const nextKey = pickLatestActiveSessionKey(remaining);

        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          remaining,
        );

        flushSync(() => {
          draftSessionActivationRequestedRef.current = false;
          setCurrentSessionKey(null);
          setMessages([]);
          setShowSuggestions(true);
          setSubagentTasks([]);
          if (nextKey) {
            navigate(`/chat/${encodeURIComponent(nextKey)}`, { replace: true });
          } else {
            navigate("/chat", { replace: true });
          }
          setSessionsSidebarOpen(false);
        });
      } else {
        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          (old) => (old ? old.filter((row) => row.key !== key) : old),
        );
      }

      return api.deleteSession(key, currentBotId);
    },
    onSuccess: (_, key) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", currentBotId] });
      queryClient.removeQueries({
        queryKey: ["session", key, currentBotId],
      });
      try {
        const stored = localStorage
          .getItem(LAST_CONSOLE_SESSION_STORAGE_KEY)
          ?.trim();
        if (stored === key) {
          localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
        }
      } catch {
        // ignore
      }
      addToast({ type: "success", message: t("chat.toastSessionDeleted") });
    },
    onError: () => {
      addToast({ type: "error", message: t("chat.toastSessionDeleteFailed") });
    },
  });

  const deleteSessionsBatchMutation = useMutation({
    mutationFn: async (keys: string[]) => {
      const keySet = new Set(keys);
      const current = activeSessionKey?.trim() ?? "";
      const isDeletingCurrent = current.length > 0 && keySet.has(current);

      if (isDeletingCurrent) {
        if (useNanobotChannel) {
          disconnectNanobotChannelWebSocket();
        }
        suppressSessionDetailForKeyRef.current = current;
        void queryClient.cancelQueries({
          queryKey: ["session", current, currentBotId],
        });
        queryClient.removeQueries({
          queryKey: ["session", current, currentBotId],
        });

        const list =
          queryClient.getQueryData<SessionInfo[]>([
            "sessions",
            currentBotId,
          ]) ?? [];
        const remaining = list.filter((row) => !keySet.has(row.key));
        const nextKey = pickLatestActiveSessionKey(remaining);

        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          remaining,
        );

        flushSync(() => {
          draftSessionActivationRequestedRef.current = false;
          setCurrentSessionKey(null);
          setMessages([]);
          setShowSuggestions(true);
          setSubagentTasks([]);
          if (nextKey) {
            navigate(`/chat/${encodeURIComponent(nextKey)}`, { replace: true });
          } else {
            navigate("/chat", { replace: true });
          }
          setSessionsSidebarOpen(false);
        });
      } else {
        queryClient.setQueryData<SessionInfo[]>(
          ["sessions", currentBotId],
          (old) => (old ? old.filter((row) => !keySet.has(row.key)) : old),
        );
      }

      return api.deleteSessionsBatch(keys, currentBotId);
    },
    onSuccess: (data, keys) => {
      queryClient.invalidateQueries({ queryKey: ["sessions", currentBotId] });
      for (const key of keys) {
        queryClient.removeQueries({
          queryKey: ["session", key, currentBotId],
        });
      }
      try {
        for (const key of keys) {
          const stored = localStorage
            .getItem(LAST_CONSOLE_SESSION_STORAGE_KEY)
            ?.trim();
          if (stored === key) {
            localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
          }
        }
      } catch {
        // ignore
      }
      setBatchSelectedKeys(new Set());
      const failed = data.failed?.length ?? 0;
      const deleted = data.deleted?.length ?? 0;
      if (failed > 0) {
        addToast({
          type: deleted > 0 ? "warning" : "error",
          message: t("chat.toastBatchPartial", { deleted, failed }),
        });
      } else {
        addToast({ type: "success", message: t("chat.toastBatchDeleted", { count: deleted }) });
      }
    },
    onError: () => {
      void queryClient.invalidateQueries({
        queryKey: ["sessions", currentBotId],
      });
      addToast({ type: "error", message: t("chat.toastBatchFailed") });
    },
  });

  const renameSessionMutation = useMutation({
    mutationFn: async (payload: { key: string; title: string }) =>
      api.updateSession(payload.key, { title: payload.title }, currentBotId),
    onSuccess: (updated) => {
      queryClient.setQueryData<SessionInfo[]>(
        ["sessions", currentBotId],
        (old) =>
          old
            ? old.map((row) =>
                row.key === updated.key
                  ? {
                      ...row,
                      title: updated.title,
                      last_message: updated.last_message,
                    }
                  : row,
              )
            : old,
      );
      addToast({ type: "success", message: t("chat.toastSessionRenamed") });
      setRenameSessionModalOpen(false);
      setRenameSessionKey(null);
      setRenameSessionTitle("");
    },
    onError: () => {
      addToast({ type: "error", message: t("chat.toastSessionRenameFailed") });
    },
  });

  /**
   * nanobot 首条消息前勿对草稿 UUID 拉 JSONL（无文件或键与 agent 不一致）。
   * 仅在路由已有 :sessionKey 或不用 nanobot WS 时请求。
   */
  const shouldFetchSessionJsonl =
    Boolean(activeSessionKey) &&
    (!useNanobotChannel || paramSessionKey !== undefined);

  const sessionJsonlFetchSuppressedForDeletedRoute =
    suppressSessionDetailForKeyRef.current !== null &&
    suppressSessionDetailForKeyRef.current === activeSessionKey;

  useEffect(() => {
    const suppressed = suppressSessionDetailForKeyRef.current;
    if (!suppressed) {
      return;
    }
    if (paramSessionKey !== suppressed) {
      suppressSessionDetailForKeyRef.current = null;
    }
  }, [paramSessionKey]);

  const { data: sessionData, isError: sessionQueryError, error: sessionQueryErrorObj } =
    useQuery({
      queryKey: ["session", activeSessionKey, currentBotId],
      /**
       * Fetch only the tail page on first load so very long conversations do
       * not bottleneck on a single mega-response; older history is paged in
       * lazily when the user scrolls up (see `loadOlderHistoryPage`).
       */
      queryFn: () =>
        api.getSessionTranscript(activeSessionKey!, currentBotId, {
          limit: CHAT_HISTORY_PAGE_SIZE,
        }),
      enabled: shouldFetchSessionJsonl && !sessionJsonlFetchSuppressedForDeletedRoute,
      retry: false,
    });

  const {
    data: sessionJsonlData,
    isPending: sessionJsonlPending,
    isError: sessionJsonlError,
    error: sessionJsonlErr,
  } = useQuery({
    queryKey: [
      "sessionJsonlRaw",
      activeSessionKey,
      currentBotId,
      sessionJsonlFileSource,
    ],
    queryFn: () =>
      api.getSessionJsonlRaw(
        activeSessionKey!,
        currentBotId,
        sessionJsonlFileSource,
      ),
    enabled: sessionJsonlModalOpen && Boolean(activeSessionKey),
    retry: false,
  });

  const sessionJsonlDisplayText = useMemo(() => {
    const raw = sessionJsonlData?.text;
    if (raw == null || raw === "") {
      return "";
    }
    return formatJsonlForDisplay(raw);
  }, [sessionJsonlData?.text]);

  const sessionJsonlCmExtensions = useMemo(
    () => [javascript(), EditorView.lineWrapping],
    [],
  );

  /**
   * Per-turn real assembled LLM context (system prompt + history + user turn).
   * Only fetched while the dialog is open on the assembled-context tab so that
   * large transcripts do not get streamed needlessly while the user sits on
   * the raw JSONL view or the dialog is closed.
   */
  const {
    data: sessionContextData,
    isPending: sessionContextPending,
    isError: sessionContextError,
    error: sessionContextErr,
  } = useQuery({
    queryKey: ["sessionContext", activeSessionKey, currentBotId],
    queryFn: () =>
      api.getSessionContext(activeSessionKey!, currentBotId),
    // Skip fetching while a turn is still streaming: the context file is
    // rewritten mid-turn and we would otherwise read a half-written record.
    // Once ``isStreaming`` flips back to false the effect below invalidates
    // the query so the freshly-written snapshot is pulled automatically.
    enabled:
      sessionJsonlModalOpen &&
      sessionContextTab === "assembled" &&
      Boolean(activeSessionKey) &&
      !isStreaming,
    retry: false,
  });

  const sessionContextLatest = sessionContextData?.latest ?? null;
  const sessionContextLatestText = sessionContextLatest?.context_text ?? "";
  const sessionContextHasRecord = Boolean(sessionContextLatest);
  const sessionContextTurnIndex = sessionContextLatest?.turn_index ?? null;
  const sessionContextTimestamp = sessionContextLatest?.timestamp ?? null;

  /**
   * Refresh the assembled-context snapshot whenever the user either opens the
   * dialog or switches back to the assembled tab.  The backend overwrites the
   * ``context/{key}.jsonl`` file on every turn, so the cached query result is
   * stale once a new turn completes — invalidating forces a fresh fetch.
   */
  useEffect(() => {
    if (!sessionJsonlModalOpen) {
      return;
    }
    if (sessionContextTab !== "assembled") {
      return;
    }
    if (!activeSessionKey) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["sessionContext", activeSessionKey, currentBotId],
    });
  }, [
    sessionJsonlModalOpen,
    sessionContextTab,
    activeSessionKey,
    currentBotId,
    queryClient,
  ]);

  /**
   * When a turn finishes streaming, the assembled context on disk has just
   * been rewritten.  If the dialog is still open on the assembled tab, pull
   * the new snapshot so the user does not have to close and reopen.
   */
  const prevIsStreamingRef = useRef<boolean>(false);
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;
    if (!wasStreaming || isStreaming) {
      return;
    }
    if (!sessionJsonlModalOpen || sessionContextTab !== "assembled") {
      return;
    }
    if (!activeSessionKey) {
      return;
    }
    void queryClient.invalidateQueries({
      queryKey: ["sessionContext", activeSessionKey, currentBotId],
    });
  }, [
    isStreaming,
    sessionJsonlModalOpen,
    sessionContextTab,
    activeSessionKey,
    currentBotId,
    queryClient,
  ]);

  /**
   * 路由里带了 :sessionKey 但磁盘上已无该会话（例如旧 bookmark）时，改为打开列表中最新创建的会话。
   */
  useEffect(() => {
    if (!sessionQueryError || !paramSessionKey) {
      return;
    }
    if (paramSessionKey !== activeSessionKey) {
      return;
    }
    if (!isSessionMissingError(sessionQueryErrorObj)) {
      return;
    }
    if (sessionsListPending) {
      return;
    }

    const list = sessions ?? [];
    if (list.length === 0) {
      draftSessionActivationRequestedRef.current = false;
      setCurrentSessionKey(null);
      navigate("/chat", { replace: true });
      return;
    }

    const newestKey = pickLatestActiveSessionKey(list);
    if (!newestKey) {
      return;
    }
    if (newestKey === paramSessionKey) {
      draftSessionActivationRequestedRef.current = false;
      setCurrentSessionKey(null);
      navigate("/chat", { replace: true });
      return;
    }

    setCurrentSessionKey(newestKey);
    navigate(`/chat/${encodeURIComponent(newestKey)}`, { replace: true });
  }, [
    sessionQueryError,
    sessionQueryErrorObj,
    paramSessionKey,
    activeSessionKey,
    sessionsListPending,
    sessions,
    navigate,
    setCurrentSessionKey,
  ]);

  // 仅路由 param 变化时清空（侧栏切换、回 /chat）；勿用 activeSessionKey，否则 stream 里
  // session_key 更新 URL 会误清空当前消息。
  const prevParamSessionKeyForMessagesRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevParamSessionKeyForMessagesRef.current;
    if (prev !== undefined && prev !== paramSessionKey) {
      setMessages([]);
    }
    // Bare `/chat`: always show the welcome hero. Do not tie this to `activeSessionKey`:
    // nanobot promotes `/chat` → `/chat/:id` before the first message, but the session
    // is still empty and should keep the hero until the user sends or history loads.
    if (paramSessionKey === undefined) {
      setShowSuggestions(true);
    }
    prevParamSessionKeyForMessagesRef.current = paramSessionKey;
  }, [paramSessionKey]);

  /**
   * Build a stable id for a transcript row.
   *
   * Previously ids were `msg-{idx}-{Date.now()}`, which meant every replay of
   * the sync effect produced new keys; that broke the virtualized list's
   * height cache and forced React to reconcile every historical row even when
   * no data changed. Keying by absolute transcript offset + role + timestamp
   * keeps ids stable across refetches while still differentiating adjacent
   * rows that share an offset slot (e.g. tool replies that reuse a ts).
   */
  const buildStableMessageId = useCallback(
    (msg: Message, absoluteIndex: number): string => {
      const ts = msg.timestamp ?? msg.created_at ?? "";
      const role = msg.role ?? "x";
      const toolCallId = msg.tool_call_id ?? "";
      return `m:${absoluteIndex}:${role}:${toolCallId}:${ts}`;
    },
    [],
  );

  useEffect(() => {
    if (!sessionData?.messages) {
      if (!activeSessionKey) {
        setShowSuggestions(true);
      }
      return;
    }

    const serverMessages = sessionData.messages as Message[];
    // Pagination metadata drives the "load older" control. `offset` is absent
    // in the legacy full-history shape; fall back to 0 so prev-page fetches
    // are disabled (nothing to page before an un-paged response).
    const nextOldestOffset =
      typeof sessionData.offset === "number" ? sessionData.offset : 0;
    const nextHasMore = Boolean(sessionData.has_more);

    if (!isStreaming) {
      setMessages((prev) => {
        // If local state already has more messages than the server tail page
        // (e.g. we just appended an assistant bubble on chat_done), don't
        // overwrite with the older paged snapshot.
        if (prev.length > serverMessages.length) return prev;
        return serverMessages.map((msg, idx) => ({
          ...msg,
          id: buildStableMessageId(msg, nextOldestOffset + idx),
        }));
      });
      setHistoryOldestOffset(nextOldestOffset);
      setHistoryHasMore(nextHasMore);
      setShowSuggestions(serverMessages.length === 0);
      return;
    }

    // Stream just started and session/transcript fetch returned messages
    // (user turn already persisted on the server). Load them so the user
    // message appears immediately.
    setMessages((prev) => {
      if (prev.length > 0) return prev;
      return serverMessages.map((msg, idx) => ({
        ...msg,
        id: buildStableMessageId(msg, nextOldestOffset + idx),
      }));
    });
    setHistoryOldestOffset(nextOldestOffset);
    setHistoryHasMore(nextHasMore);
  }, [sessionData, activeSessionKey, isStreaming, buildStableMessageId]);

  // Keep sidebar message_count in sync with GET /sessions/:key/transcript without refetching the full list.
  const sessionMessageCount = sessionData?.message_count;
  useEffect(() => {
    if (!activeSessionKey || sessionMessageCount === undefined) {
      return;
    }
    queryClient.setQueryData<SessionInfo[]>(
      ["sessions", currentBotId],
      (old) => {
        if (!old) {
          return old;
        }
        let changed = false;
        const next = old.map((row) => {
          if (row.key !== activeSessionKey) {
            return row;
          }
          if (row.message_count === sessionMessageCount) {
            return row;
          }
          changed = true;
          return { ...row, message_count: sessionMessageCount };
        });
        return changed ? next : old;
      },
    );
  }, [activeSessionKey, sessionMessageCount, currentBotId, queryClient]);

  /**
   * 先把 `role: tool` 的 content 合并进对应 `tool_call_id` 的 assistant
   * tool_calls，再按 source 过滤子 Agent / tool_call 行。
   */
  const displayMessages = useMemo(() => {
    const merged = mergeToolResultsIntoAssistantMessages(messages);
    const normalized = merged.map((m) => normalizeMessageForChatRender(m));
    const visible = normalized.filter(
      (m) => m.source !== "sub_agent" && m.source !== "tool_call",
    );
    return groupAssistantReplies(visible);
  }, [messages]);

  /**
   * Try to load the previous history page when the user scrolls near the top.
   *
   * Anchor restoration: we capture the current (scrollHeight - scrollTop)
   * delta before the pending page is appended; after React commits the new
   * rows we add the growth back so the viewport appears frozen in place
   * rather than jumping up to the new top.
   */
  const loadOlderHistoryPage = useCallback(async () => {
    if (loadingOlderRef.current) return;
    if (!historyHasMore) return;
    if (!activeSessionKey) return;
    if (historyOldestOffset === null || historyOldestOffset <= 0) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);

    // Find the scroll parent the virtual list mounted; it owns the scroll
    // offset we need to restore after prepending rows.
    const scroller = document.querySelector<HTMLDivElement>(
      '[data-testid="chat-virtual-scroll"]',
    );
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    try {
      const page = await api.getSessionTranscript(
        activeSessionKey,
        currentBotId,
        {
          limit: CHAT_HISTORY_PAGE_SIZE,
          beforeIndex: historyOldestOffset,
        },
      );
      const older = (page.messages ?? []) as Message[];
      const newOldestOffset =
        typeof page.offset === "number" ? page.offset : 0;
      const nextHasMore = Boolean(page.has_more);

      if (older.length > 0) {
        setMessages((prev) => {
          const prepended: Message[] = older.map((msg, idx) => ({
            ...msg,
            id: buildStableMessageId(msg, newOldestOffset + idx),
          }));
          return [...prepended, ...prev];
        });
      }
      setHistoryOldestOffset(newOldestOffset);
      setHistoryHasMore(nextHasMore);

      // Restore scroll position after layout settles. Using requestAnimation-
      // Frame twice ensures measurement + paint have both flushed so the
      // growth we add is the final value.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scroller) return;
          const growth = scroller.scrollHeight - prevScrollHeight;
          if (growth > 0) {
            scroller.scrollTop = prevScrollTop + growth;
          }
        });
      });
    } catch (err) {
      addToast({
        type: "error",
        message:
          err instanceof Error
            ? `${t("chat.loadOlderFailed")}: ${err.message}`
            : t("chat.loadOlderFailed"),
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [
    historyHasMore,
    historyOldestOffset,
    activeSessionKey,
    currentBotId,
    buildStableMessageId,
    addToast,
    t,
  ]);

  /**
   * Poll the virtual list scroll offset on every scroll event:
   * - keeps `messagesStickToBottomRef` accurate so new tokens only auto-scroll
   *   when the user is actively reading the tail;
   * - drives the "jump to latest" pill;
   * - triggers prev-page lazy loads when the viewport nears the top.
   */
  const handleVirtualScroll = useCallback(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    const distBottom = handle.distanceFromBottom();
    const nearBottom = distBottom <= CHAT_NEAR_BOTTOM_PX;
    messagesStickToBottomRef.current = nearBottom;
    setShowJumpToBottom(!nearBottom);
    if (nearBottom) {
      setUnreadBelowCount(0);
    }

    const scroller = document.querySelector<HTMLDivElement>(
      '[data-testid="chat-virtual-scroll"]',
    );
    if (
      scroller &&
      scroller.scrollTop <= CHAT_HISTORY_TOP_TRIGGER_PX &&
      historyHasMore &&
      !loadingOlderRef.current
    ) {
      void loadOlderHistoryPage();
    }
  }, [virtualListHandleRef, historyHasMore, loadOlderHistoryPage]);

  // Attach scroll listener to the virtualization scroll parent.
  useEffect(() => {
    const attach = () => {
      const scroller = document.querySelector<HTMLDivElement>(
        '[data-testid="chat-virtual-scroll"]',
      );
      if (!scroller) return null;
      scroller.addEventListener("scroll", handleVirtualScroll, { passive: true });
      return scroller;
    };
    // React commits before we can find the node; wait one frame.
    let scrollerEl: HTMLDivElement | null = null;
    const raf = requestAnimationFrame(() => {
      scrollerEl = attach();
    });
    return () => {
      cancelAnimationFrame(raf);
      if (scrollerEl) {
        scrollerEl.removeEventListener("scroll", handleVirtualScroll);
      }
    };
  }, [handleVirtualScroll, activeSessionKey]);

  /**
   * Auto-follow only when the user is near the bottom. We additionally count
   * unread assistant bubbles while the user is reading older history so the
   * "jump to latest" pill can surface a helpful hint.
   */
  useEffect(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    if (displayMessages.length <= 1 && !isStreaming) {
      handle.scrollToBottom(false);
      messagesStickToBottomRef.current = true;
      setShowJumpToBottom(false);
      setUnreadBelowCount(0);
      return;
    }
    if (messagesStickToBottomRef.current) {
      handle.scrollToBottom(false);
    } else {
      // User scrolled up; bump the unread counter whenever a new message is
      // appended (either assistant finalization or streaming start).
      setUnreadBelowCount((n) => n + 1);
    }
  }, [
    virtualListHandleRef,
    displayMessages.length,
    isStreaming,
  ]);

  /**
   * During streaming we only want to follow the tail; we intentionally do
   * NOT bump the unread counter on every token, and we skip the scroll when
   * the user is away from the bottom. Split out from the length effect so
   * the high-frequency `streamingContent` / tool progress updates don't
   * trigger the length-based "unread" bump.
   */
  useEffect(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    if (!messagesStickToBottomRef.current) return;
    handle.scrollToBottom(false);
  }, [
    virtualListHandleRef,
    streamingContent,
    streamingToolProgress.length,
    streamingChannelNotices.length,
    streamingPayloadToolCalls.length,
    streamingReasoningContent,
    isStreaming,
  ]);

  const jumpToBottom = useCallback(() => {
    const handle = virtualListHandleRef.current;
    if (!handle) return;
    messagesStickToBottomRef.current = true;
    setUnreadBelowCount(0);
    setShowJumpToBottom(false);
    handle.scrollToBottom(true);
  }, [virtualListHandleRef]);

  const handleStreamChunk = useCallback(
    (chunk: StreamChunk, source: ChatChunkSource) => {
      // When both transports are configured, bind this page to a single
      // source to prevent duplicate tokens / `chat_done` events from
      // console `/ws` and nanobot `/nanobot-ws` being merged into one stream.
      if (useNanobotChannel) {
        if (source !== "nanobot") {
          return;
        }
      } else if (source !== "console") {
        return;
      }
      // Lock the streaming bubble's reply_group_id to the first server-issued
      // value observed in this turn. The runtime stamps the same UUID onto
      // every frame, so we don't need to update it on later frames.
      if (
        chunk.reply_group_id &&
        typeof chunk.reply_group_id === "string" &&
        !streamingReplyGroupIdRef.current
      ) {
        streamingReplyGroupIdRef.current = chunk.reply_group_id;
      }
      if (silentStatusJsonRef.current) {
        if (chunk.type === "session_key") {
          return;
        }
        if (chunk.type === "chat_start") {
          return;
        }
        if (
          chunk.type === "chat_token" ||
          chunk.type === "nanobot_status_json" ||
          chunk.type === "channel_notice"
        ) {
          const chunkText =
            typeof chunk.content === "string" ? chunk.content : "";
          silentStatusJsonBufferRef.current += chunkText;
          const assembled = silentStatusJsonBufferRef.current;
          if (parseNanobotStatusJson(assembled) !== null) {
            completeSilentStatusJsonPoll(assembled, { fromEarlyParse: true });
          }
          return;
        }
        if (chunk.type === "stream_frame_end") {
          return;
        }
        if (chunk.type === "chat_done") {
          const assembled =
            silentStatusJsonBufferRef.current +
            (typeof chunk.content === "string" ? chunk.content : "");
          completeSilentStatusJsonPoll(assembled);
          return;
        }
        if (chunk.type === "error" && chunk.error) {
          completeSilentStatusJsonPoll("");
          return;
        }
        return;
      }
      if (chunk.type === "nanobot_status_json") {
        const raw = typeof chunk.content === "string" ? chunk.content : "";
        const parsed = parseNanobotStatusJson(raw);
        if (parsed) {
          setNanobotContextUsage(parsed);
        }
        return;
      }
      if (chunk.type === "session_key" && chunk.session_key) {
        const nextKey = chunk.session_key.trim();
        if (!nextKey) {
          return;
        }
        const shouldAdoptServerSessionKey =
          !activeSessionKey ||
          draftSessionActivationRequestedRef.current ||
          readNanobotChatNewIntent();
        if (!shouldAdoptServerSessionKey && nextKey !== activeSessionKey) {
          // Keep current thread stable during normal chatting; only draft/new
          // flows can adopt a new server session key.
          return;
        }
        draftSessionActivationRequestedRef.current = false;
        setCurrentSessionKey(nextKey);
        navigate(`/chat/${encodeURIComponent(nextKey)}`, {
          replace: true,
        });
        queryClient.invalidateQueries({ queryKey: ["sessions"] });
      } else if (chunk.type === "chat_start") {
        streamingPrimedByServerRef.current = false;
        setIsStreaming(true);
      } else if (chunk.type === "channel_notice" && chunk.content) {
        streamingPrimedByServerRef.current = false;
        setIsStreaming(true);
        const noticeText = chunk.content as string;
        const usageFromStatus = parseNanobotStatusJson(noticeText);
        if (usageFromStatus) {
          setNanobotContextUsage(usageFromStatus);
        }
        setStreamingChannelNotices((prev) => [...prev, noticeText]);
        if (
          typeof chunk.reasoning_content === "string" &&
          chunk.reasoning_content.length > 0
        ) {
          streamingReasoningContentRef.current = chunk.reasoning_content;
          setStreamingReasoningContent(chunk.reasoning_content);
        }
      } else if (chunk.type === "chat_token") {
        const hasText =
          typeof chunk.content === "string" && chunk.content.length > 0;
        const hasEmbeddedTools = chunk.tool_calls !== undefined;
        const hasReasoning = chunk.reasoning_content !== undefined;
        if (!hasText && !hasEmbeddedTools && !hasReasoning) {
          return;
        }
        if (hasText && chunk.content) {
          streamingContentRef.current += chunk.content;
          pendingStreamTokenDeltaRef.current += chunk.content;
          if (streamTokenFlushRafRef.current === null) {
            streamTokenFlushRafRef.current = requestAnimationFrame(() => {
              streamTokenFlushRafRef.current = null;
              const delta = pendingStreamTokenDeltaRef.current;
              pendingStreamTokenDeltaRef.current = "";
              if (delta) {
                setStreamingContent((prev) => prev + delta);
              }
            });
          }
        }
        if (hasEmbeddedTools) {
          const incoming = chunk.tool_calls ?? [];
          scheduleTranscriptSync();
          if (isStreamingRef.current) {
            const merged = mergeStreamingToolCalls(
              streamingPayloadToolCallsRef.current,
              incoming,
            );
            streamingPayloadToolCallsRef.current = merged;
            setStreamingPayloadToolCalls(merged);
          } else {
            /* nanobot may send tool_event after chat_end; merge into last assistant bubble. */
            streamingPayloadToolCallsRef.current = [];
            setStreamingPayloadToolCalls([]);
            setMessages((prev) => {
              if (prev.length === 0) {
                return prev;
              }
              const lastIdx = prev.length - 1;
              const last = prev[lastIdx];
              if (last.role !== "assistant") {
                return prev;
              }
              const mergedCalls = mergeStreamingToolCalls(
                last.tool_calls ?? [],
                incoming,
              );
              const next = [...prev];
              next[lastIdx] = { ...last, tool_calls: mergedCalls };
              return next;
            });
            queryClient.setQueryData(
              ["session", activeSessionKey, currentBotId],
              (old: typeof sessionData | undefined) => {
                if (!old?.messages?.length) {
                  return old;
                }
                const msgs = [...(old.messages ?? [])];
                const li = msgs.length - 1;
                const last = msgs[li] as Message | undefined;
                if (!last || last.role !== "assistant") {
                  return old;
                }
                const mergedCalls = mergeStreamingToolCalls(
                  last.tool_calls ?? [],
                  incoming,
                );
                msgs[li] = { ...last, tool_calls: mergedCalls };
                return { ...old, messages: msgs };
              },
            );
          }
        }
        if (hasReasoning) {
          const r = chunk.reasoning_content ?? "";
          if (chunk.reasoning_append) {
            const merged = streamingReasoningContentRef.current + r;
            streamingReasoningContentRef.current = merged;
            setStreamingReasoningContent(merged);
          } else {
            streamingReasoningContentRef.current = r;
            setStreamingReasoningContent(r);
          }
        }
      } else if (chunk.type === "stream_frame_end") {
        cancelStreamTokenFlush();
        if (chunk.tool_calls?.length) {
          const incoming = chunk.tool_calls;
          const merged = mergeStreamingToolCalls(
            streamingPayloadToolCallsRef.current,
            incoming,
          );
          streamingPayloadToolCallsRef.current = merged;
          setStreamingPayloadToolCalls(merged);
          scheduleTranscriptSync();
        }
        if (chunk.reasoning_content !== undefined) {
          streamingReasoningContentRef.current = chunk.reasoning_content;
          setStreamingReasoningContent(chunk.reasoning_content);
        }
      } else if (chunk.type === "tool_progress" && chunk.content) {
        setStreamingToolProgress((prev) => [...prev, chunk.content as string]);
      } else if (chunk.type === "tool_call" && chunk.tool_call) {
        const tc = chunk.tool_call;
        setToolCalls((prev) => [
          ...prev,
          {
            id: tc.id,
            name: tc.name,
            args: JSON.stringify(tc.arguments, null, 2),
            status: "running",
          },
        ]);
      } else if (chunk.type === "tool_result" && chunk.tool_name) {
        setToolCalls((prev) =>
          prev.map((tc) =>
            tc.name === chunk.tool_name
              ? { ...tc, status: "success", result: chunk.tool_result }
              : tc,
          ),
        );
      } else if (chunk.type === "error" && chunk.error) {
        setStreamingChannelNotices([]);
        setStreamingToolProgress([]);
        setToolCalls((prev) =>
          prev.map((tc) => ({ ...tc, status: "error", result: chunk.error })),
        );
        addToast({ type: "error", message: chunk.error });
      } else if (
        chunk.type === "subagent_start" &&
        chunk.subagent_id &&
        chunk.label
      ) {
        // Subagent started - add to panel
        const subagentId = chunk.subagent_id;
        const subagentLabel = chunk.label;
        setSubagentTasks((prev) => [
          ...prev,
          {
            id: subagentId,
            label: subagentLabel,
            task: chunk.task,
            status: "running",
          },
        ]);
        setSubagentPanelOpen(true);
      } else if (chunk.type === "assistant_message" && chunk.content) {
        const assistantContent = chunk.content;
        setMessages((prev) => [
          ...prev,
          {
            id: `msg-${Date.now()}-${Math.random()}`,
            role: "assistant",
            content: assistantContent,
            created_at: new Date().toISOString(),
            source: chunk.source ?? "main_agent",
            ...(chunk.tool_calls?.length ? { tool_calls: chunk.tool_calls } : {}),
            ...(chunk.reasoning_content
              ? { reasoning_content: chunk.reasoning_content }
              : {}),
            ...(chunk.reply_group_id
              ? { reply_group_id: chunk.reply_group_id }
              : {}),
          },
        ]);
      } else if (chunk.type === "subagent_done" && chunk.subagent_id) {
        // Subagent completed - update status
        setSubagentTasks((prev) =>
          prev.map((task) =>
            task.id === chunk.subagent_id
              ? {
                  ...task,
                  status: chunk.status === "ok" ? "success" : "error",
                  result: chunk.result,
                }
              : task,
          ),
        );
      } else if (chunk.type === "chat_done") {
        if (expectStatusJsonTrailingChatDoneRef.current) {
          const streamedText = streamingContentRef.current;
          const fromChunk = resolveChatDonePrimaryText(chunk);
          const hasReal =
            fromChunk.trim().length > 0 ||
            streamedText.trim().length > 0 ||
            (chunk.tool_calls?.length ?? 0) > 0 ||
            streamingPayloadToolCallsRef.current.length > 0 ||
            streamingReasoningContentRef.current.length > 0;
          expectStatusJsonTrailingChatDoneRef.current = false;
          if (!hasReal) {
            return;
          }
        }
        if (assistantReplyFinalizedRef.current) {
          return;
        }
        assistantReplyFinalizedRef.current = true;
        cancelStreamTokenFlush();
        const refTools = streamingPayloadToolCallsRef.current;
        const refReason = streamingReasoningContentRef.current;
        const chunkTools = chunk.tool_calls ?? [];
        const mergedToolCalls =
          chunkTools.length > 0 || refTools.length > 0
            ? mergeStreamingToolCalls(refTools, chunkTools)
            : undefined;
        const mergedReasoning =
          chunk.reasoning_content !== undefined
            ? chunk.reasoning_content
            : refReason || undefined;
        const streamedText = streamingContentRef.current;
        const primary = resolveChatDonePrimaryText(chunk);
        const fromChunk = primary !== "" ? primary : streamedText;
        streamingContentRef.current = "";
        streamingPayloadToolCallsRef.current = [];
        streamingReasoningContentRef.current = "";
        setStreamingPayloadToolCalls([]);
        setStreamingReasoningContent("");
        setIsStreaming(false);
        setStreamingContent("");
        setStreamingToolProgress([]);
        setStreamingChannelNotices([]);
        const assistantMsg: Message = {
          id: `msg-${Date.now()}`,
          role: "assistant",
          content: fromChunk,
          created_at: new Date().toISOString(),
          source: chunk.source ?? "main_agent",
          ...(mergedToolCalls && mergedToolCalls.length > 0
            ? { tool_calls: mergedToolCalls }
            : {}),
          ...(mergedReasoning !== undefined && mergedReasoning.length > 0
            ? { reasoning_content: mergedReasoning }
            : {}),
          ...(chunk.reply_group_id
            ? { reply_group_id: chunk.reply_group_id }
            : streamingReplyGroupIdRef.current
              ? { reply_group_id: streamingReplyGroupIdRef.current }
              : {}),
        };
        streamingReplyGroupIdRef.current = null;
        setMessages((prev) => [...prev, assistantMsg]);
        setToolCalls([]);
        // Any throttled mid-turn transcript refresh is superseded by chat_done.
        cancelTranscriptSync();
        // Scope to the active bot to match the canonical sessions query key
        // used elsewhere in the file (e.g. ["sessions", currentBotId]).
        queryClient.invalidateQueries({ queryKey: ["sessions", currentBotId] });
        // Update the session cache so sessionData stays in sync with the latest session.
        // Functional form reads current cache at call time, avoiding stale closure values.
        queryClient.setQueryData(
          ["session", activeSessionKey, currentBotId],
          (old: typeof sessionData | undefined) => {
            if (!old) return old;
            return {
              ...old,
              messages: [...(old.messages ?? []), assistantMsg],
              message_count: (old.message_count ?? 0) + 1,
            };
          },
        );
        if (useNanobotChannel) {
          scheduleNanobotStatusJson();
        }
      }
    },
    [
      addToast,
      queryClient,
      navigate,
      setCurrentSessionKey,
      activeSessionKey,
      currentBotId,
      cancelStreamTokenFlush,
      completeSilentStatusJsonPoll,
      scheduleNanobotStatusJson,
      scheduleTranscriptSync,
      cancelTranscriptSync,
      useNanobotChannel,
    ],
  );

  // Register WebSocket chat message handler (WS streaming replaces SSE)
  useEffect(() => {
    const unregister = registerChatHandler(handleStreamChunk);
    return unregister;
  }, [handleStreamChunk]);

  // Clean up any pending transcript refetch timer on unmount / session change.
  useEffect(() => {
    return () => cancelTranscriptSync();
  }, [cancelTranscriptSync]);

  // nanobot `ws` 频道：连接就绪后发送队列中的首条消息（新会话）
  useEffect(() => {
    if (!useNanobotChannel || !nanobotWsReady) {
      return;
    }
    const pending = pendingNanobotOutboundRef.current;
    if (!pending) {
      return;
    }
    try {
      sendNanobotMessage({
        content: pending,
        botId: currentBotId,
      });
      pendingNanobotOutboundRef.current = null;
    } catch {
      pendingNanobotOutboundRef.current = null;
      cancelStreamTokenFlush();
      setIsStreaming(false);
      setStreamingContent("");
      streamingContentRef.current = "";
      addToast({
        type: "error",
        message: t("chat.toastWsSendFailed"),
      });
    }
  }, [
    useNanobotChannel,
    nanobotWsReady,
    currentBotId,
    sendNanobotMessage,
    addToast,
    cancelStreamTokenFlush,
    t,
  ]);

  /** After each nanobot channel `ready` (connect or reconnect), refresh context via `/status`. */
  useEffect(() => {
    if (!useNanobotChannel || !nanobotWsReady) {
      return;
    }
    scheduleNanobotStatusJson();
  }, [useNanobotChannel, nanobotWsReady, scheduleNanobotStatusJson]);

  const handleSend = async () => {
    if (!input.trim() || isStreaming) return;

    const userMessage = input.trim();
    setInput("");
    setShowSuggestions(false);
    messagesStickToBottomRef.current = true;

    setMessages((prev) => [
      ...prev,
      {
        id: `user-${Date.now()}`,
        role: "user",
        content: userMessage,
        created_at: new Date().toISOString(),
        source: "user",
      },
    ]);

    cancelStreamTokenFlush();
    assistantReplyFinalizedRef.current = false;
    setIsStreaming(true);
    setStreamingContent("");
    streamingContentRef.current = "";
    setToolCalls([]);
    setStreamingToolProgress([]);
    setStreamingChannelNotices([]);
    setStreamingPayloadToolCalls([]);
    setStreamingReasoningContent("");
    streamingPayloadToolCallsRef.current = [];
    streamingReasoningContentRef.current = "";
    streamingReplyGroupIdRef.current = null;

    if (useNanobotChannel) {
      if (!activeSessionKey) {
        // Bare `/chat` stays as draft until first message is sent. Once outbound
        // starts, mark activation and materialize the server session on `ready`.
        draftSessionActivationRequestedRef.current = true;
        setDraftSessionActivationTick((n) => n + 1);
        // Opt-in flag to let `nanobotChannelWsEnabled` open the socket on the
        // bare `/chat` route. Without this, an empty sessions list keeps the
        // WS closed (avoiding the empty-session ghost on backend restart) and
        // pending messages would never reach the server.
        try {
          sessionStorage.setItem(NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY, "1");
        } catch {
          // ignore quota / private mode
        }
        pendingNanobotOutboundRef.current = userMessage;
        if (nanobotWsReady) {
          try {
            sendNanobotMessage({
              content: userMessage,
              botId: currentBotId,
            });
            pendingNanobotOutboundRef.current = null;
          } catch {
            cancelStreamTokenFlush();
            setIsStreaming(false);
            setStreamingContent("");
            streamingContentRef.current = "";
            pendingNanobotOutboundRef.current = null;
            addToast({
              type: "error",
              message: t("chat.toastWsSendFailed"),
            });
          }
        }
        return;
      }
      if (!nanobotWsReady) {
        pendingNanobotOutboundRef.current = userMessage;
        return;
      }
      try {
        sendNanobotMessage({
          content: userMessage,
          botId: currentBotId,
        });
      } catch {
        cancelStreamTokenFlush();
        setIsStreaming(false);
        setStreamingContent("");
        streamingContentRef.current = "";
        addToast({
          type: "error",
          message: t("chat.toastWsNotReady"),
        });
      }
      return;
    }

    const ws = getWSRef()?.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      cancelStreamTokenFlush();
      setIsStreaming(false);
      setStreamingContent("");
      streamingContentRef.current = "";
      addToast({ type: "error", message: t("chat.toastWsNotConnected") });
      return;
    }

    ws.send(JSON.stringify({
      type: "chat",
      message: userMessage,
      session_key: activeSessionKey || undefined,
      bot_id: currentBotId || undefined,
    }));
  };

  const handleStop = () => {
    // Agent interruption is not yet supported via WebSocket.
    // Stop button clears local streaming state only.
    cancelStreamTokenFlush();
    setIsStreaming(false);
    setStreamingContent("");
    streamingContentRef.current = "";
    setToolCalls([]);
    setStreamingToolProgress([]);
    setStreamingChannelNotices([]);
    setStreamingPayloadToolCalls([]);
    setStreamingReasoningContent("");
    streamingPayloadToolCallsRef.current = [];
    streamingReasoningContentRef.current = "";
    streamingReplyGroupIdRef.current = null;
    addToast({ type: "info", message: t("chat.toastStopped") });
  };

  const handleNewChat = () => {
    draftSessionActivationRequestedRef.current = false;
    try {
      localStorage.removeItem(LAST_CONSOLE_SESSION_STORAGE_KEY);
      sessionStorage.setItem(NANOBOT_CHAT_NEW_INTENT_STORAGE_KEY, "1");
    } catch {
      // ignore
    }
    // Clear nanobot handshake state so the next WS uses a fresh placeholder and
    // `ready.client_id` drives the new session; otherwise stale ids keep the old
    // connection key and sidebar selection.
    useAppStore.getState().setNanobotChatId(null);
    useAppStore.getState().setNanobotClientId(null);
    setCurrentSessionKey(null);
    setMessages([]);
    setShowSuggestions(true);
    setSubagentTasks([]);
    navigate("/chat");
    inputRef.current?.focus();
    newChatSidebarScrollUntilRef.current = Date.now() + 12000;
    setNewChatSidebarScrollToken((n) => n + 1);
    setSessionsSidebarOpen(true);
    setSessionsSidebarCollapsed(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSelectSession = (sessionKey: string) => {
    setCurrentSessionKey(sessionKey);
    navigate(`/chat/${encodeURIComponent(sessionKey)}`);
    setSessionsSidebarOpen(false);
  };

  const openRenameSessionModal = (session: SessionInfo) => {
    setRenameSessionKey(session.key);
    setRenameSessionTitle(session.title || "");
    setRenameSessionModalOpen(true);
  };

  const handleRenameSessionSubmit = () => {
    const key = renameSessionKey?.trim();
    if (!key) {
      return;
    }
    renameSessionMutation.mutate({
      key,
      title: renameSessionTitle.trim(),
    });
  };

  const suggestions = useMemo(
    () => [
      {
        text: t("chat.suggestionReviewText"),
        label: t("chat.suggestionReviewLabel"),
      },
      {
        text: t("chat.suggestionAutomationText"),
        label: t("chat.suggestionAutomationLabel"),
      },
      {
        text: t("chat.suggestionScriptText"),
        label: t("chat.suggestionScriptLabel"),
      },
    ],
    [t],
  );

  const toolCallTagColor = (status: TrackedToolCall["status"]) => {
    if (status === "running") return "processing";
    if (status === "success") return "success";
    return "error";
  };

  const trackedToolStatusLabel = (status: TrackedToolCall["status"]) => {
    if (status === "running") return t("subagent.running");
    if (status === "success") return t("subagent.completed");
    return t("subagent.failed");
  };

  /** Message time in agent-configured IANA timezone (matches nanobot logs). */
  const formatMessageTime = (isoStr: string | undefined): string => {
    const locale = i18n.language.startsWith("zh") ? "zh-CN" : "en-US";
    return formatChatMessageTime(isoStr, agentTz, locale);
  };

  /** nanobot may emit `stream_end` before the last `tool_event`; keep bubble while tools still stream in. */
  const showStreamingAssistantBubble =
    isStreaming &&
    (Boolean(streamingContent) ||
      streamingChannelNotices.length > 0 ||
      streamingToolProgress.length > 0 ||
      streamingPayloadToolCalls.length > 0 ||
      streamingReasoningContent.length > 0);

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden overflow-x-hidden bg-gradient-to-br from-gray-50 via-white to-gray-100 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900 relative">
      {/* Mobile Sessions Toggle Button */}
      <button
        onClick={() => setSessionsSidebarOpen(!sessionsSidebarOpen)}
        className="md:hidden fixed bottom-20 right-4 z-30 p-3 bg-gradient-to-r from-primary-500 to-primary-600 text-white rounded-full shadow-lg shadow-primary-500/30 hover:shadow-xl hover:scale-105 transition-all"
      >
        {sessionsSidebarOpen ? (
          <X className="w-5 h-5" />
        ) : (
          <MessageSquare className="w-5 h-5" />
        )}
      </button>

      {/* Sessions Sidebar */}
      <div
        className={`
          ${sessionsSidebarOpen ? "translate-x-0" : "-translate-x-full"}
          ${sessionsSidebarCollapsed ? "md:-translate-x-full md:w-0 md:pointer-events-none md:overflow-hidden" : "md:translate-x-0 md:w-72"}
          fixed md:relative z-20 h-screen md:h-full
          w-72 bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl border-r border-gray-200/50 dark:border-gray-700/50
          flex flex-col transition-transform duration-300 ease-out
        `}
      >
        <div className="h-12 shrink-0 px-3.5 flex items-center gap-3 border-b border-gray-200/50 dark:border-gray-700/50 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm min-w-0">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <span className="text-sm font-semibold text-gray-700 dark:text-gray-200 truncate min-w-0">
              {t("chat.sessionsTitle")}
            </span>
            {sessions && sessions.length > 0 ? (
              <div className="flex items-center gap-2 shrink-0">
                <Checkbox
                  indeterminate={
                    batchSelectedKeys.size > 0 &&
                    batchSelectedKeys.size < sessions.length
                  }
                  checked={sessions.every((s) =>
                    batchSelectedKeys.has(s.key),
                  )}
                  onChange={(e) => {
                    if (e.target.checked) {
                      setBatchSelectedKeys(new Set(sessions.map((s) => s.key)));
                    } else {
                      setBatchSelectedKeys(new Set());
                    }
                  }}
                  title={t("chat.selectAll")}
                />
                {batchSelectedKeys.size > 0 ? (
                  <span
                    className="text-xs leading-none text-gray-500 dark:text-gray-400 tabular-nums min-w-[1.25rem]"
                    title={t("chat.selectedCount", {
                      count: batchSelectedKeys.size,
                    })}
                  >
                    {batchSelectedKeys.size}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="flex items-center gap-0.5 shrink-0">
            {sessions && sessions.length > 0 ? (
              <Popconfirm
                title={t("chat.batchDeleteTitle")}
                description={t("chat.batchDeleteDesc", {
                  count: batchSelectedKeys.size,
                })}
                onConfirm={() =>
                  deleteSessionsBatchMutation.mutate([...batchSelectedKeys])
                }
                okText={t("common.delete")}
                cancelText={t("common.cancel")}
                okButtonProps={{ danger: true }}
                disabled={batchSelectedKeys.size === 0}
              >
                <Button
                  danger
                  type="text"
                  size="small"
                  icon={<DeleteOutlined />}
                  className="!w-9 !h-9 !min-w-9 flex items-center justify-center"
                  disabled={
                    batchSelectedKeys.size === 0 ||
                    deleteSessionsBatchMutation.isPending
                  }
                  loading={deleteSessionsBatchMutation.isPending}
                  title={t("chat.batchDelete")}
                />
              </Popconfirm>
            ) : null}
            <Button
              type="text"
              icon={<MenuFoldOutlined />}
              onClick={() => {
                setSessionsSidebarCollapsed(true);
                setSessionsSidebarOpen(false);
              }}
              className="!w-9 !h-9 !min-w-9 flex items-center justify-center"
              title={t("chat.collapseSidebar")}
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-3.5 py-4 space-y-3">
          {sessionsListPending && sessions === undefined ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-gray-500 dark:text-gray-400">
              <Spin size="small" />
              <span className="text-xs">{t("chat.loadSessions")}</span>
            </div>
          ) : sessionsListError ? (
            <p className="text-sm text-center text-amber-700 dark:text-amber-300 px-2 py-6 leading-relaxed">
              {t("chat.sessionsLoadError")}
            </p>
          ) : !sessions?.length ? (
            <p className="text-sm text-center text-gray-500 dark:text-gray-400 px-2 py-10 leading-relaxed">
              {t("chat.sessionsEmpty")}
            </p>
          ) : null}
          {(
            [
              {
                key: "main" as const,
                label: t("chat.mainAgentSessions"),
                rows: groupedSessions.main,
              },
              {
                key: "teams" as const,
                label: t("chat.teamSessions"),
                rows: groupedSessions.teams,
              },
            ] as const
          ).map((group) => {
            if (!group.rows.length) {
              return null;
            }
            const expanded = sessionTreeExpanded[group.key];
            return (
              <div key={group.key} className="space-y-2">
                <button
                  type="button"
                  onClick={() =>
                    setSessionTreeExpanded((prev) => ({
                      ...prev,
                      [group.key]: !prev[group.key],
                    }))
                  }
                  className="w-full flex items-center justify-between px-2 py-1.5 rounded-md bg-gray-100/80 dark:bg-gray-700/40 hover:bg-gray-100 dark:hover:bg-gray-700/60 text-gray-700 dark:text-gray-200 transition-colors"
                >
                  <span className="inline-flex items-center gap-2 min-w-0">
                    {expanded ? (
                      <ChevronDown className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-300" />
                    ) : (
                      <ChevronRight className="w-3.5 h-3.5 shrink-0 text-gray-500 dark:text-gray-300" />
                    )}
                    <span className="text-xs font-semibold uppercase tracking-wide">
                      {group.label}
                    </span>
                  </span>
                  <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                    {group.rows.length}
                  </span>
                </button>
                {expanded ? (
                  <div className="space-y-2 pl-3 border-l border-gray-200/80 dark:border-gray-700/80">
                    {group.rows.map((session) => (
                      <div
                        key={session.key}
                        ref={(el) => {
                          if (el) {
                            sessionSidebarRowRefs.current.set(session.key, el);
                          } else {
                            sessionSidebarRowRefs.current.delete(session.key);
                          }
                        }}
                        className={`flex items-stretch gap-2 rounded-md transition-all ${
                          activeSessionKey === session.key
                            ? "bg-gradient-to-r from-primary-50 to-blue-50 dark:from-primary-900/30 dark:to-blue-900/20 text-primary-700 dark:text-primary-300"
                            : "hover:bg-gray-100 dark:hover:bg-gray-700/50"
                        }`}
                      >
                        <div className="flex items-center justify-center shrink-0 pl-3 pr-0.5 py-3">
                          <Checkbox
                            checked={batchSelectedKeys.has(session.key)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                              e.stopPropagation();
                              const checked = e.target.checked;
                              setBatchSelectedKeys((prev) => {
                                const next = new Set(prev);
                                if (checked) {
                                  next.add(session.key);
                                } else {
                                  next.delete(session.key);
                                }
                                return next;
                              });
                            }}
                          />
                        </div>
                        <button
                          type="button"
                          onClick={() => handleSelectSession(session.key)}
                          className="flex-1 min-w-0 text-left py-3.5 pr-2 rounded-l-lg"
                        >
                          <span className="flex items-center gap-1.5 min-w-0">
                            {session.team_id ? (
                              <Users
                                className="w-3.5 h-3.5 shrink-0 text-blue-500 dark:text-blue-400"
                                aria-label="team session"
                              />
                            ) : (
                              <Bot
                                className="w-3.5 h-3.5 shrink-0 text-violet-500 dark:text-violet-400"
                                aria-label="agent session"
                              />
                            )}
                            <span className="text-sm font-medium truncate block leading-snug min-w-0">
                              {session.title || session.key}
                            </span>
                          </span>
                          <span className="text-xs text-gray-500 mt-1.5 block leading-relaxed">
                            {t("chat.messageCount", { count: session.message_count })}
                          </span>
                          {session.created_at && (
                            <span className="text-xs text-gray-400 dark:text-gray-500 mt-1 block leading-relaxed">
                              {formatMessageTime(session.created_at)}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            openRenameSessionModal(session);
                          }}
                          title={t("chat.renameSession")}
                          className="self-center shrink-0 w-9 h-9 my-2 flex items-center justify-center rounded-md text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:text-gray-500 dark:hover:text-blue-300 dark:hover:bg-blue-500/10 transition-colors duration-150"
                        >
                          <EditOutlined className="text-base" />
                        </button>
                        <Popconfirm
                          title={t("chat.deleteSessionTitle")}
                          description={t("chat.deleteSessionDesc", {
                            name: session.title || session.key,
                          })}
                          onConfirm={() => deleteSessionMutation.mutate(session.key)}
                          okText={t("common.delete")}
                          cancelText={t("common.cancel")}
                          okButtonProps={{ danger: true }}
                        >
                          <button
                            type="button"
                            onClick={(e) => e.stopPropagation()}
                            title={t("chat.deleteSession")}
                            className="self-center shrink-0 w-9 h-9 mr-2 my-2 flex items-center justify-center rounded-md text-gray-400 hover:text-red-500 hover:bg-red-50 dark:text-gray-500 dark:hover:text-red-400 dark:hover:bg-red-500/10 transition-colors duration-150"
                          >
                            <DeleteOutlined className="text-base" />
                          </button>
                        </Popconfirm>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {/* Mobile Overlay */}
      {sessionsSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/50 z-10 backdrop-blur-sm"
          onClick={() => setSessionsSidebarOpen(false)}
        />
      )}

      {sessionsSidebarCollapsed && (
        <Button
          type="text"
          icon={<MenuUnfoldOutlined />}
          onClick={() => setSessionsSidebarCollapsed(false)}
          className="hidden md:flex absolute left-2 top-20 z-30 text-gray-500 hover:text-primary-500 bg-white/80 dark:bg-gray-900/80 rounded-full shadow"
          title={t("chat.expandSidebar")}
        />
      )}

      {/* Chat Area */}
      <div className="flex-1 flex min-w-0 min-h-0">
        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {/* Header */}
          <div className="h-12 px-6 flex items-center justify-between border-b border-gray-200/50 dark:border-gray-700/50 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-md bg-gradient-to-br from-primary-500 to-primary-600 shadow-lg shadow-primary-500/20">
                <Bot className="w-5 h-5 text-white" />
              </div>
              <div>
                <h2 className="text-lg font-semibold">{t("chat.title")}</h2>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  {t("chat.subtitle")}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {activeSessionKey ? (
                <>
                  <Button
                    icon={<FileText className="w-4 h-4" />}
                    onClick={() => {
                      setSessionJsonlFileSource("session");
                      setSessionContextTab("assembled");
                      setSessionJsonlModalOpen(true);
                    }}
                    className="hidden md:inline-flex"
                  >
                    {t("chat.viewContextJsonl")}
                  </Button>
                  <Button
                    shape="circle"
                    icon={<FileText className="w-4 h-4" />}
                    onClick={() => {
                      setSessionJsonlFileSource("session");
                      setSessionContextTab("assembled");
                      setSessionJsonlModalOpen(true);
                    }}
                    className="md:!hidden shrink-0"
                    title={t("chat.viewContextJsonl")}
                    aria-label={t("chat.viewContextJsonl")}
                  />
                </>
              ) : null}
              {sessions && sessions.length > 0 && (
                <>
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleNewChat}
                    className="hidden md:inline-flex"
                  >
                    {t("chat.newChat")}
                  </Button>
                  <Button
                    type="primary"
                    shape="circle"
                    icon={<PlusOutlined />}
                    onClick={handleNewChat}
                    className="md:!hidden shrink-0"
                    title={t("chat.newChat")}
                    aria-label={t("chat.newChat")}
                  />
                </>
              )}
            </div>
          </div>

          {/* Messages / Hero */}
          {displayMessages.length === 0 && showSuggestions ? (
            <div
              ref={messagesContainerRef}
              className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-4 md:px-6 py-2 md:py-3"
            >
              <div className="min-h-full flex flex-col items-center justify-start pt-2 md:pt-4 text-center text-gray-600 dark:text-gray-300">
                <div className="w-20 h-20 rounded-md bg-gradient-to-br from-primary-100 to-blue-100 dark:from-primary-900/30 dark:to-blue-900/20 flex items-center justify-center mb-6 shadow-xl shadow-primary-500/10">
                  <Bot className="w-10 h-10 text-primary-600" />
                </div>
                <h3 className="text-2xl font-bold mb-3 bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
                  {t("chat.heroTitle")}
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-8 max-w-md">
                  {t("chat.heroSubtitle")}
                </p>
                <div className="grid gap-3 w-full max-w-xl">
                  {suggestions.map((suggestion, idx) => (
                    <button
                      key={idx}
                      onClick={() => {
                        setInput(suggestion.text);
                        inputRef.current?.focus();
                      }}
                      className="flex items-center justify-between px-5 py-4 rounded-md bg-white dark:bg-gray-800 shadow-sm hover:shadow-md border border-gray-100 dark:border-gray-700 text-left text-sm transition-shadow duration-200 group"
                    >
                      <div className="flex items-center gap-3">
                        <Wand2 className="w-4 h-4 text-primary-500" />
                        <span className="font-medium">{suggestion.label}</span>
                      </div>
                      <span className="text-gray-400 group-hover:translate-x-1 transition-transform">
                        →
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="relative flex-1 min-h-0 flex flex-col">
              <VirtualizedMessageList
                items={displayMessages}
                getKey={(msg) => msg.id}
                registerHandle={setVirtualListHandle}
                header={
                  historyHasMore || loadingOlder ? (
                    <div className="flex items-center justify-center py-2 text-xs text-gray-500 dark:text-gray-400">
                      {loadingOlder ? (
                        <span className="inline-flex items-center gap-2">
                          <LoadingOutlined />
                          {t("chat.loadingOlder")}
                        </span>
                      ) : historyHasMore ? (
                        <button
                          type="button"
                          onClick={() => void loadOlderHistoryPage()}
                          className="inline-flex items-center gap-2 rounded-full px-3 py-1 bg-gray-100 dark:bg-gray-700/60 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-600 dark:text-gray-300 transition-colors"
                        >
                          {t("chat.loadingOlder")}
                        </button>
                      ) : null}
                    </div>
                  ) : null
                }
                renderItem={(msg) => {
                  const extraAbove =
                    msg.role === "assistant" ? (
                      <>
                        {msg.reasoning_content ? (
                          <MessageThinkingBlock text={msg.reasoning_content} />
                        ) : null}
                        <MessageToolCallsBlock
                          noTopMargin={!msg.reasoning_content}
                          tool_calls={msg.tool_calls}
                        />
                      </>
                    ) : null;
                  const ts = msg.created_at ?? msg.timestamp;
                  return (
                    <MessageRow
                      msg={msg}
                      extraAbove={extraAbove}
                      formattedTime={ts ? formatMessageTime(ts) : null}
                    />
                  );
                }}
                footer={
                  <>
                    {showStreamingAssistantBubble && (
                      <>
                        <div className="flex gap-3 w-full min-w-0">
                          <div className="w-10 h-10 rounded-md bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-600 flex items-center justify-center shrink-0">
                            <Bot className="w-5 h-5 text-gray-600 dark:text-gray-300" />
                          </div>
                          <div className="bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 rounded-md px-5 py-4 shadow-sm min-w-0 flex-1 max-w-full mr-[calc(2.5rem+0.75rem)]">
                            {streamingChannelNotices.length > 0 ? (
                              <div className="space-y-2 mb-3 pb-3 border-b border-amber-200/70 dark:border-amber-700/50">
                                <div className="flex items-center gap-2 pl-0.5">
                                  <Info
                                    className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400 shrink-0"
                                    strokeWidth={2}
                                    aria-hidden
                                  />
                                  <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-700/90 dark:text-amber-400/90">
                                    {t("chat.statusLabel")}
                                  </span>
                                </div>
                                {streamingChannelNotices.map((line, idx) => (
                                  <p
                                    key={`${idx}-${line.slice(0, 48)}`}
                                    className="text-[12px] sm:text-[13px] leading-snug text-amber-950 dark:text-amber-100/95 m-0"
                                  >
                                    {line}
                                  </p>
                                ))}
                              </div>
                            ) : null}
                            {streamingReasoningContent.length > 0 ? (
                              <MessageThinkingBlock
                                text={streamingReasoningContent}
                              />
                            ) : null}
                            {streamingPayloadToolCalls.length > 0 ? (
                              <div
                                className={
                                  streamingReasoningContent.length > 0 ||
                                  streamingChannelNotices.length > 0
                                    ? "mt-3 pt-3 border-t border-gray-100 dark:border-gray-700"
                                    : ""
                                }
                              >
                                <MessageToolCallsBlock
                                  noTopMargin
                                  tool_calls={streamingPayloadToolCalls}
                                />
                              </div>
                            ) : null}
                            {streamingContent ? (
                              <div
                                className={`text-[15px] leading-relaxed text-gray-900 dark:text-gray-100 whitespace-pre-wrap break-words ${
                                  streamingReasoningContent.length > 0 ||
                                  streamingPayloadToolCalls.length > 0 ||
                                  streamingChannelNotices.length > 0
                                    ? "mt-3 pt-3 border-t border-gray-100 dark:border-gray-700"
                                    : ""
                                }`}
                              >
                                {streamingContent}
                              </div>
                            ) : null}
                            {streamingToolProgress.length > 0 ? (
                              <div
                                className={
                                  streamingContent ||
                                  streamingPayloadToolCalls.length > 0 ||
                                  streamingReasoningContent.length > 0 ||
                                  streamingChannelNotices.length > 0
                                    ? "mt-3 pt-3 border-t border-gray-100 dark:border-gray-700 space-y-2"
                                    : "space-y-2"
                                }
                              >
                                <div className="flex items-center gap-2 pl-0.5">
                                  <Wrench
                                    className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500 shrink-0"
                                    strokeWidth={2}
                                    aria-hidden
                                  />
                                  <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                                    {t("chat.toolCalls")}
                                  </span>
                                </div>
                                {streamingToolProgress.map((hint, idx) => (
                                  <pre
                                    key={`${idx}-${hint.slice(0, 24)}`}
                                    className="text-[11px] sm:text-xs leading-relaxed font-mono text-slate-600 dark:text-slate-400 bg-slate-50 dark:bg-slate-950/80 rounded-md px-3 py-2.5 whitespace-pre-wrap break-all m-0 overflow-x-auto ring-1 ring-inset ring-slate-200/60 dark:ring-slate-700/50 border-0"
                                  >
                                    {formatToolHintMultiline(hint)}
                                  </pre>
                                ))}
                              </div>
                            ) : null}
                            {streamingContent.trim().length > 0 ? (
                              <span
                                className="mt-3 inline-flex items-center gap-1 text-primary-500"
                                aria-hidden
                              >
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
                                <span className="inline-block w-1.5 h-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
                              </span>
                            ) : (
                              <LoadingOutlined className="mt-2 text-primary-500" />
                            )}
                          </div>
                        </div>

                        {toolCalls.length > 0 && (
                          <div className="flex gap-3 w-full min-w-0 mt-4">
                            <div
                              className="w-10 min-w-[2.5rem] shrink-0"
                              aria-hidden
                            />
                            <div className="flex-1 min-w-0 space-y-2 mr-[calc(2.5rem+0.75rem)]">
                              {toolCalls.map((tc) => (
                                <div
                                  key={tc.id}
                                  className={`rounded-md p-4 border ${
                                    tc.status === "running"
                                      ? "bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800"
                                      : tc.status === "success"
                                        ? "bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800"
                                        : "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800"
                                  }`}
                                >
                                  <div className="flex items-center gap-2 mb-2">
                                    {tc.status === "running" ? (
                                      <LoadingOutlined className="text-blue-500" />
                                    ) : tc.status === "success" ? (
                                      <CheckOutlined className="text-green-500" />
                                    ) : (
                                      <CloseOutlined className="text-red-500" />
                                    )}
                                    <span className="font-medium text-sm">
                                      {tc.name}
                                    </span>
                                    <Tag color={toolCallTagColor(tc.status)}>
                                      {trackedToolStatusLabel(tc.status)}
                                    </Tag>
                                  </div>
                                  {tc.args && (
                                    <pre className="text-xs bg-gray-900 text-gray-100 p-2 rounded-md overflow-x-auto">
                                      {tc.args}
                                    </pre>
                                  )}
                                  {tc.result && (
                                    <pre className="text-xs mt-2 bg-gray-900 text-gray-100 p-2 rounded-md overflow-x-auto max-h-32">
                                      {tc.result.slice(0, 500)}
                                      {tc.result.length > 500 && "..."}
                                    </pre>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </>
                    )}
                    <div ref={messagesEndRef} />
                  </>
                }
              />

              {showJumpToBottom ? (
                <button
                  type="button"
                  onClick={jumpToBottom}
                  className="absolute bottom-4 right-4 md:right-6 z-10 inline-flex items-center gap-1.5 rounded-full bg-primary-500 hover:bg-primary-600 text-white text-xs px-3 py-1.5 shadow-lg shadow-primary-500/30 transition-colors"
                  aria-label={t("chat.jumpToBottom")}
                  title={t("chat.jumpToBottom")}
                >
                  <ChevronRight className="w-3.5 h-3.5 rotate-90" aria-hidden />
                  <span>
                    {unreadBelowCount > 0
                      ? t("chat.jumpToBottomNewMessages")
                      : t("chat.jumpToBottom")}
                  </span>
                </button>
              ) : null}
            </div>
          )}

          {/* Input */}
          <div className="bg-white/80 dark:bg-gray-800/80 backdrop-blur-xl pb-safe">
            <div className="w-full min-w-0 max-w-3xl mx-auto px-4 md:px-6 py-4">
              <ChatInput
                inputRef={inputRef}
                value={input}
                onChange={setInput}
                onKeyDown={handleKeyDown}
                onSend={handleSend}
                onStop={handleStop}
                isStreaming={isStreaming}
                showContextMeter={useNanobotChannel}
                contextUsage={nanobotContextUsage}
                contextLoading={statusJsonLoading}
              />
            </div>
          </div>
        </div>

        {/* Subagent Panel */}
        {subagentTasks.length > 0 && (
          <SubagentPanel
            tasks={subagentTasks}
            collapsed={!subagentPanelOpen}
            onCollapse={() => setSubagentPanelOpen(false)}
          />
        )}
      </div>

      <Modal
        open={sessionJsonlModalOpen}
        onCancel={() => {
          setSessionJsonlModalOpen(false);
          if (activeSessionKey) {
            queryClient.removeQueries({
              queryKey: ["sessionContext", activeSessionKey, currentBotId],
            });
          }
        }}
        title={t("chat.viewContextJsonl")}
        footer={null}
        width="min(100vw - 2rem, 48rem)"
        destroyOnClose
        styles={{
          root: { maxHeight: "min(92vh, 44rem)" },
          body: {
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
            maxHeight: "min(82vh, 40rem)",
            overflow: "hidden",
            padding: "8px 24px 20px",
          },
        }}
      >
        <Tabs
          activeKey={sessionContextTab}
          onChange={(k) =>
            setSessionContextTab(k === "raw" ? "raw" : "assembled")
          }
          className="h-[min(70vh,32rem)] min-h-[14rem] flex flex-col [&>.ant-tabs-content-holder]:flex-1 [&>.ant-tabs-content-holder]:min-h-0 [&_.ant-tabs-content]:h-full [&_.ant-tabs-tabpane]:h-full"
          destroyInactiveTabPane
          items={[
            {
              key: "assembled",
              label: t("chat.contextAssembledTab"),
              children: (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {sessionContextHasRecord
                        ? sessionContextTurnIndex != null
                          ? t("chat.contextAssembledTurnInfo", {
                              index: sessionContextTurnIndex,
                              timestamp: sessionContextTimestamp ?? "",
                            })
                          : t("chat.contextAssembledLatest", {
                              timestamp: sessionContextTimestamp ?? "",
                            })
                        : t("chat.contextAssembledEmpty")}
                    </span>
                    <Button
                      type="primary"
                      icon={<Copy className="w-3.5 h-3.5" />}
                      disabled={!sessionContextLatestText}
                      onClick={() => {
                        if (sessionContextLatestText) {
                          void navigator.clipboard.writeText(
                            sessionContextLatestText,
                          );
                          addToast({
                            type: "success",
                            message: t("chat.contextJsonlCopied"),
                          });
                        }
                      }}
                    >
                      {t("chat.contextJsonlCopy")}
                    </Button>
                  </div>
                  {sessionContextPending ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <Spin />
                    </div>
                  ) : sessionContextError ? (
                    <p className="m-0 shrink-0 text-sm text-red-600 dark:text-red-400">
                      {t("chat.contextAssembledLoadError")}:{" "}
                      {sessionContextErr instanceof Error
                        ? sessionContextErr.message
                        : String(sessionContextErr)}
                    </p>
                  ) : !sessionContextHasRecord ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-gray-500 dark:text-gray-400">
                      {t("chat.contextAssembledEmptyHint")}
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]">
                      <CodeMirror
                        value={sessionContextLatestText}
                        height="100%"
                        className="h-full min-h-0 text-[13px] [&_.cm-editor]:!h-full [&_.cm-editor]:!max-h-full [&_.cm-scroller]:!overflow-auto [&_.cm-content]:!pb-3"
                        readOnly
                        theme={codeMirrorIsDark ? vscodeDark : vscodeLight}
                        extensions={sessionJsonlCmExtensions}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: true,
                          highlightActiveLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
            {
              key: "raw",
              label: t("chat.contextRawTab"),
              children: (
                <div className="flex h-full min-h-0 flex-col gap-3">
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    <span className="text-sm text-gray-500 dark:text-gray-400">
                      {t("chat.contextJsonlFileSource")}
                    </span>
                    <Select
                      value={sessionJsonlFileSource}
                      onChange={(v) => setSessionJsonlFileSource(v)}
                      className="min-w-[12rem]"
                      options={[
                        {
                          value: "session",
                          label: t("chat.contextJsonlFileSession"),
                        },
                        {
                          value: "transcript",
                          label: t("chat.contextJsonlFileTranscript"),
                        },
                      ]}
                    />
                    <Button
                      type="primary"
                      icon={<Copy className="w-3.5 h-3.5" />}
                      disabled={!sessionJsonlData?.text}
                      onClick={() => {
                        if (sessionJsonlData?.text) {
                          void navigator.clipboard.writeText(
                            sessionJsonlData.text,
                          );
                          addToast({
                            type: "success",
                            message: t("chat.contextJsonlCopied"),
                          });
                        }
                      }}
                    >
                      {t("chat.contextJsonlCopy")}
                    </Button>
                  </div>
                  {sessionJsonlPending ? (
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <Spin />
                    </div>
                  ) : sessionJsonlError ? (
                    <p className="m-0 shrink-0 text-sm text-red-600 dark:text-red-400">
                      {t("chat.contextJsonlLoadError")}:{" "}
                      {sessionJsonlErr instanceof Error
                        ? sessionJsonlErr.message
                        : String(sessionJsonlErr)}
                    </p>
                  ) : (
                    <div className="min-h-0 flex-1 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]">
                      <CodeMirror
                        value={sessionJsonlDisplayText}
                        height="100%"
                        className="h-full min-h-0 text-[13px] [&_.cm-editor]:!h-full [&_.cm-editor]:!max-h-full [&_.cm-scroller]:!overflow-auto [&_.cm-content]:!pb-3"
                        readOnly
                        theme={codeMirrorIsDark ? vscodeDark : vscodeLight}
                        extensions={sessionJsonlCmExtensions}
                        basicSetup={{
                          lineNumbers: true,
                          foldGutter: true,
                          highlightActiveLine: false,
                        }}
                      />
                    </div>
                  )}
                </div>
              ),
            },
          ]}
        />
      </Modal>
      <Modal
        open={renameSessionModalOpen}
        onCancel={() => {
          if (renameSessionMutation.isPending) {
            return;
          }
          setRenameSessionModalOpen(false);
          setRenameSessionKey(null);
          setRenameSessionTitle("");
        }}
        title={t("chat.renameSession")}
        onOk={handleRenameSessionSubmit}
        okText={t("common.save")}
        cancelText={t("common.cancel")}
        okButtonProps={{
          loading: renameSessionMutation.isPending,
          disabled: !renameSessionKey,
        }}
        destroyOnClose
      >
        <div className="space-y-2">
          <p className="m-0 text-xs text-gray-500 dark:text-gray-400">
            {t("chat.renameSessionHint")}
          </p>
          <Input
            value={renameSessionTitle}
            maxLength={120}
            onPressEnter={(e) => {
              e.preventDefault();
              handleRenameSessionSubmit();
            }}
            onChange={(e) => setRenameSessionTitle(e.target.value)}
            placeholder={t("chat.renameSessionPlaceholder")}
          />
        </div>
      </Modal>
    </div>
  );
}
