import { memo, type ReactNode } from "react";
import { Bot, User } from "lucide-react";
import { Markdown } from "../../components/Markdown";
import type { ToolCall } from "../../api/types";

/**
 * Single chat row used by the virtualized list. The row is intentionally a
 * thin wrapper around the same markup previously inlined inside `Chat.tsx`
 * so that:
 *
 * - React.memo can short-circuit re-renders when neither the message object
 *   nor the rendered timestamp changed (historical rows no longer participate
 *   in the input / streaming state's reconciliation).
 * - Thinking / tool-call blocks stay owned by the parent: they are passed in
 *   as `extraAbove` children so MessageRow has zero additional dependencies
 *   on translation / tool utilities.
 */
export interface MessageRowMsg {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_call_id?: string;
  tool_name?: string;
  created_at?: string;
  timestamp?: string;
  source?: "user" | "main_agent" | "sub_agent" | "tool_call";
  tool_calls?: ToolCall[];
  reasoning_content?: string;
}

interface MessageRowProps {
  msg: MessageRowMsg;
  /** Pre-rendered blocks that live above the markdown body (thinking / tool calls). */
  extraAbove?: ReactNode;
  /** Formatted "HH:mm" style timestamp; omitted when empty. */
  formattedTime?: string | null;
}

function MessageRowComponent({ msg, extraAbove, formattedTime }: MessageRowProps) {
  const isUser = msg.role === "user";
  const isAssistant = msg.role === "assistant";

  return (
    <div
      className={`flex gap-3 w-full min-w-0 overflow-visible ${
        isUser ? "flex-row-reverse" : ""
      }`}
    >
      <div
        className={`w-10 h-10 min-w-[2.5rem] min-h-[2.5rem] rounded-md flex items-center justify-center flex-shrink-0 overflow-visible p-1.5 box-border ${
          isUser
            ? "bg-sky-500 dark:bg-sky-600 text-white shadow-md shadow-sky-500/20"
            : "bg-gradient-to-br from-gray-100 to-gray-200 dark:from-gray-700 dark:to-gray-600"
        }`}
      >
        {isUser ? (
          <User
            className="w-5 h-5 min-w-5 min-h-5 text-white flex-shrink-0"
            strokeWidth={2}
          />
        ) : (
          <Bot className="w-5 h-5 text-gray-600 dark:text-gray-300" />
        )}
      </div>
      <div
        className={`relative rounded-md px-5 py-4 ${
          isUser
            ? "shrink-0 w-fit max-w-[min(100%,85%)] min-w-[8rem] bg-sky-50 dark:bg-sky-950/45 text-slate-800 dark:text-slate-100 border border-sky-200/90 dark:border-sky-800/55 shadow-sm rounded-br-sm"
            : "flex-1 min-w-0 mr-[calc(2.5rem+0.75rem)] bg-white dark:bg-gray-800 border border-gray-100 dark:border-gray-700 shadow-sm rounded-bl-sm"
        }`}
      >
        {extraAbove}
        <div
          className={`prose prose-sm max-w-none ${
            isUser ? "prose-slate dark:prose-invert" : "dark:prose-invert"
          } ${
            isAssistant &&
            (msg.reasoning_content || (msg.tool_calls?.length ?? 0) > 0)
              ? "mt-3 pt-3 border-t border-gray-100 dark:border-gray-700"
              : ""
          }`}
        >
          <Markdown>{msg.content}</Markdown>
        </div>
        {formattedTime ? (
          <div
            className={`mt-2 text-xs ${
              isUser
                ? "text-slate-500 dark:text-slate-400"
                : "text-gray-400 dark:text-gray-500"
            }`}
          >
            {formattedTime}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Memoized: the parent passes stable message objects (mutations produce a new
 * reference) and a stable formattedTime string, so the default shallow compare
 * is enough to skip re-rendering historical rows while the user types or new
 * tokens stream into the tail bubble.
 */
export const MessageRow = memo(MessageRowComponent);
