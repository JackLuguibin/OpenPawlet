import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, CornerDownLeft, HelpCircle } from "lucide-react";

import type { ToolCall } from "../../api/types";

/**
 * Pull the question + options out of an ``ask_user`` tool-call's arguments.
 *
 * The arguments may arrive partially streamed (``_raw`` only, no parsed
 * fields) so we fall back to scanning ``_raw`` for the JSON object.
 */
function extractAskUserArgs(
  args: Record<string, unknown> | undefined,
): { question: string; options: string[] } {
  if (!args) {
    return { question: "", options: [] };
  }

  let question =
    typeof args.question === "string" ? args.question.trim() : "";
  let options: string[] = Array.isArray(args.options)
    ? (args.options as unknown[])
        .map((o) => (typeof o === "string" ? o.trim() : ""))
        .filter(Boolean)
    : [];

  if ((!question || options.length === 0) && typeof args._raw === "string") {
    try {
      const parsed = JSON.parse(args._raw) as Record<string, unknown>;
      if (!question && typeof parsed.question === "string") {
        question = parsed.question.trim();
      }
      if (options.length === 0 && Array.isArray(parsed.options)) {
        options = (parsed.options as unknown[])
          .map((o) => (typeof o === "string" ? o.trim() : ""))
          .filter(Boolean);
      }
    } catch {
      // ignore — partial stream, fall back to whatever we already have
    }
  }

  return { question, options };
}

interface AskUserPromptProps {
  /** The ``ask_user`` tool call to render. */
  toolCall: ToolCall;
  /**
   * Submit the selected/typed answer. The parent is expected to push the
   * text as a normal user message; nanobot will route it back as the
   * matching tool result automatically.
   */
  onAnswer: (text: string) => void;
  /**
   * Disable interaction: either a reply is already streaming back, or the
   * tool call has already been answered (``result`` set on a transcript
   * row), or a sibling prompt was just submitted.
   */
  disabled?: boolean;
  /** When the user has already answered, render the result as a static chip. */
  answeredText?: string | null;
}

/**
 * Cursor-style interactive selection card for the ``ask_user`` agent tool.
 *
 * Renders the question, a stack of clickable option buttons, and a small
 * free-text fallback so users can type a custom answer. Submitting either
 * route calls ``onAnswer`` exactly once and visually locks the card.
 */
export function AskUserPrompt({
  toolCall,
  onAnswer,
  disabled,
  answeredText,
}: AskUserPromptProps) {
  const { t } = useTranslation();
  const { question, options } = useMemo(
    () => extractAskUserArgs(toolCall.arguments),
    [toolCall.arguments],
  );

  // Local "submitted" flag so the buttons immediately reflect the click
  // even before the round-trip echo arrives from the server.
  const [submittedValue, setSubmittedValue] = useState<string | null>(null);
  const [customText, setCustomText] = useState("");

  const settledAnswer =
    submittedValue ??
    (typeof toolCall.result === "string" && toolCall.result.trim()
      ? toolCall.result.trim()
      : answeredText ?? null);

  const isLocked = disabled === true || settledAnswer !== null;

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLocked) {
      return;
    }
    setSubmittedValue(trimmed);
    onAnswer(trimmed);
  };

  return (
    <div className="rounded-lg ring-1 ring-sky-200/80 dark:ring-sky-700/45 bg-gradient-to-br from-sky-50/90 to-white dark:from-sky-950/40 dark:to-gray-900/40 px-4 py-3.5 shadow-sm">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 dark:bg-sky-900/50 text-sky-600 dark:text-sky-300">
          <HelpCircle className="h-3.5 w-3.5" strokeWidth={2.25} aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-700/90 dark:text-sky-300/90">
              {t("chat.askUserBadge")}
            </span>
            {isLocked ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                <Check className="h-3 w-3" strokeWidth={2.5} aria-hidden />
                {t("chat.askUserAnswered")}
              </span>
            ) : null}
          </div>
          {question ? (
            <p className="mt-1.5 text-[13.5px] leading-relaxed text-slate-800 dark:text-slate-100 whitespace-pre-wrap break-words m-0">
              {question}
            </p>
          ) : null}
        </div>
      </div>

      {options.length > 0 ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {options.map((option, idx) => {
            const isSelected = settledAnswer === option;
            const isDimmed = isLocked && !isSelected;
            return (
              <button
                key={`${idx}-${option}`}
                type="button"
                onClick={() => submit(option)}
                disabled={isLocked}
                className={[
                  "group/opt relative flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-all",
                  isSelected
                    ? "border-emerald-400/80 dark:border-emerald-500/70 bg-emerald-50 dark:bg-emerald-950/35 text-emerald-900 dark:text-emerald-100 shadow-sm shadow-emerald-500/10"
                    : isDimmed
                      ? "border-slate-200/70 dark:border-slate-700/60 bg-slate-50/70 dark:bg-slate-900/40 text-slate-500 dark:text-slate-500 cursor-not-allowed"
                      : "border-sky-200/80 dark:border-sky-700/55 bg-white dark:bg-gray-900/55 text-slate-800 dark:text-slate-100 hover:border-sky-400/85 hover:bg-sky-50/80 dark:hover:bg-sky-900/30 hover:shadow-sm cursor-pointer",
                ].join(" ")}
              >
                <span
                  className={[
                    "shrink-0 inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold ring-1 ring-inset transition-colors",
                    isSelected
                      ? "bg-emerald-500 text-white ring-emerald-500"
                      : isDimmed
                        ? "bg-slate-100 dark:bg-slate-800 text-slate-400 ring-slate-200/70 dark:ring-slate-700/60"
                        : "bg-sky-50 dark:bg-sky-900/45 text-sky-700 dark:text-sky-300 ring-sky-200/70 dark:ring-sky-700/50 group-hover/opt:bg-sky-100 dark:group-hover/opt:bg-sky-800/60",
                  ].join(" ")}
                >
                  {isSelected ? (
                    <Check className="h-2.5 w-2.5" strokeWidth={3} aria-hidden />
                  ) : (
                    idx + 1
                  )}
                </span>
                <span className="min-w-0 flex-1 break-words leading-snug">
                  {option}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {!isLocked ? (
        <div className="mt-3 flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit(customText);
                }
              }}
              placeholder={t("chat.askUserCustomPlaceholder")}
              className="w-full rounded-md border border-slate-200/80 dark:border-slate-700/60 bg-white dark:bg-gray-900/55 px-3 py-1.5 pr-10 text-[12.5px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-sky-400/85 focus:ring-2 focus:ring-sky-200/70 dark:focus:ring-sky-700/40 transition-colors"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-300 dark:text-slate-500">
              <CornerDownLeft className="h-3 w-3" strokeWidth={2} aria-hidden />
            </span>
          </div>
          <button
            type="button"
            onClick={() => submit(customText)}
            disabled={!customText.trim()}
            className="shrink-0 rounded-md bg-sky-500 px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm shadow-sky-500/25 transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500"
          >
            {t("chat.askUserSubmit")}
          </button>
        </div>
      ) : settledAnswer && !options.includes(settledAnswer) ? (
        <div className="mt-3 rounded-md border border-emerald-200/70 dark:border-emerald-800/55 bg-emerald-50/80 dark:bg-emerald-950/30 px-3 py-2 text-[12.5px] text-emerald-900 dark:text-emerald-100">
          <span className="font-medium mr-1.5">
            {t("chat.askUserYourReply")}:
          </span>
          <span className="break-words">{settledAnswer}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Identify ``ask_user`` agent calls so callers can swap in a custom UI. */
export function isAskUserToolCall(tc: ToolCall): boolean {
  return typeof tc.name === "string" && tc.name === "ask_user";
}
