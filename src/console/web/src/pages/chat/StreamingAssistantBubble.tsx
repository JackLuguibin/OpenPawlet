import { useTranslation } from "react-i18next";
import { Bot, Info, Wrench } from "lucide-react";
import {
  CheckOutlined,
  CloseOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import { Tag } from "antd";

import { MessageThinkingBlock } from "./MessageThinkingBlock";
import { MessageToolCallsBlock } from "./MessageToolCalls";
import { formatToolHintMultiline } from "./replyGroup";
import type { TrackedToolCall } from "./types";
import type { ToolCall } from "../../api/types";

interface StreamingAssistantBubbleProps {
  /** Channel-notice strings emitted by nanobot before the first token. */
  streamingChannelNotices: string[];
  /** Reasoning text streamed before the final answer. */
  streamingReasoningContent: string;
  /** In-progress tool_calls payload (richer than `toolCalls` chips). */
  streamingPayloadToolCalls: ToolCall[];
  /** Visible streaming text body. */
  streamingContent: string;
  /** One-liner tool call hints emitted as `chat_token`s. */
  streamingToolProgress: string[];
  /** WS-level tracked tool calls (status chips at the bottom). */
  toolCalls: TrackedToolCall[];
}

function trackedToolTagColor(status: TrackedToolCall["status"]) {
  if (status === "running") return "processing";
  if (status === "success") return "success";
  return "error";
}

/**
 * Streaming assistant tail bubble rendered inside the virtualized message
 * list footer while a reply is in flight. Pure render: every piece of state
 * is provided by the parent so the same component can be exercised in
 * Storybook/unit tests with deterministic input.
 *
 * Layout follows the historical inline structure:
 *   1. Channel notices (amber, top divider).
 *   2. Reasoning ("thinking") block.
 *   3. Tool-calls payload block (rich UI from `MessageToolCallsBlock`).
 *   4. Streamed text body.
 *   5. Tool progress hints (lightweight one-liners).
 *   6. Either a 3-dot pulse (when text exists) or a spinner (warming up).
 *   7. Tracked tool-call chips (rendered as a sibling row beneath the bubble).
 */
export function StreamingAssistantBubble({
  streamingChannelNotices,
  streamingReasoningContent,
  streamingPayloadToolCalls,
  streamingContent,
  streamingToolProgress,
  toolCalls,
}: StreamingAssistantBubbleProps) {
  const { t } = useTranslation();

  const trackedToolStatusLabel = (status: TrackedToolCall["status"]) => {
    if (status === "running") return t("subagent.running");
    if (status === "success") return t("subagent.completed");
    return t("subagent.failed");
  };

  return (
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
            <MessageThinkingBlock text={streamingReasoningContent} />
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
          <div className="w-10 min-w-[2.5rem] shrink-0" aria-hidden />
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
                  <span className="font-medium text-sm">{tc.name}</span>
                  <Tag color={trackedToolTagColor(tc.status)}>
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
  );
}
