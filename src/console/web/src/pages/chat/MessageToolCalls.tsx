import { useCallback, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Check, CheckCircle2, ChevronRight, Copy, Wrench } from "lucide-react";

import i18n from "../../i18n";
import type { ToolCall } from "../../api/types";
import { normalizeToolCallsArray } from "../../utils/toolCalls";
import { AskUserPrompt, isAskUserToolCall } from "./AskUserPrompt";

/**
 * Safe display for tool arguments. `JSON.stringify(undefined)` is `undefined`
 * and renders nothing in React — avoid empty expanded panels.
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

/**
 * Pick a short human-readable preview from a tool's arguments to show in the
 * collapsed summary row. Returns `null` when no string-shaped argument is
 * available (caller hides the chip in that case).
 */
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

interface MessageToolCallsBlockProps {
  tool_calls?: ToolCall[];
  /** When the surrounding container already provides spacing/dividers. */
  noTopMargin?: boolean;
  /**
   * Submit a user answer for an `ask_user` tool call rendered inside this
   * block. When omitted, ask_user calls fall back to the standard
   * collapsible row (read-only / historical view).
   */
  onAskUserAnswer?: (text: string) => void;
  /** Disable the interactive ask_user prompt (e.g. while a reply streams). */
  askUserDisabled?: boolean;
}

export function MessageToolCallsBlock({
  tool_calls,
  noTopMargin,
  onAskUserAnswer,
  askUserDisabled,
}: MessageToolCallsBlockProps) {
  const { t } = useTranslation();
  const normalizedList = useMemo(() => {
    const list = tool_calls ?? [];
    return normalizeToolCallsArray(list as unknown);
  }, [tool_calls]);

  // Split ``ask_user`` calls out so they render as interactive prompt
  // cards above the standard collapsible tool-call list.
  const askUserCalls = useMemo(
    () => normalizedList.filter(isAskUserToolCall),
    [normalizedList],
  );
  const otherCalls = useMemo(
    () => normalizedList.filter((tc) => !isAskUserToolCall(tc)),
    [normalizedList],
  );

  if (normalizedList.length === 0) {
    return null;
  }

  // ``ask_user`` always renders as a prompt card (interactive when this
  // bubble is the latest pending one, read-only "已回复" view otherwise)
  // so transcript replay and live streaming surface the same UX. Other
  // tool calls keep the collapsible row layout below.
  const hasAskUser = askUserCalls.length > 0;
  const standardList = hasAskUser ? otherCalls : normalizedList;
  // Provide a no-op callback for read-only cards so AskUserPrompt's
  // ``onAnswer`` prop stays required-shaped while never firing — the
  // ``askUserCardsDisabled`` flag below short-circuits the card before it
  // ever invokes onAnswer, so the empty fn is purely a TS shape filler.
  const askUserOnAnswer = onAskUserAnswer ?? (() => {});
  const askUserCardsDisabled = !onAskUserAnswer || askUserDisabled === true;

  return (
    <div className={`${noTopMargin ? "" : "mt-3"} space-y-2.5`}>
      {hasAskUser ? (
        <div className="space-y-2">
          {askUserCalls.map((tc) => (
            <AskUserPrompt
              key={tc.id}
              toolCall={tc}
              onAnswer={askUserOnAnswer}
              disabled={askUserCardsDisabled}
            />
          ))}
        </div>
      ) : null}
      {standardList.length > 0 ? (
        <>
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
            {standardList.map((tc) => {
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
        </>
      ) : null}
    </div>
  );
}
