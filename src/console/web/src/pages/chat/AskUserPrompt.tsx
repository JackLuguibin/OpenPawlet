import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  CheckOutlined,
  EnterOutlined,
  QuestionCircleOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";

import type { ToolCall } from "../../api/types";

/** Separator used to join multiple selected options into one tool result. */
const MULTI_SELECT_JOIN = "、";

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

/**
 * Decompose a settled answer into the matched options + custom tail so the
 * read-only view can re-highlight chosen choices on transcript replay.
 *
 * Splits on the multi-select join character first, then case-insensitively
 * matches each fragment against the offered options. Anything left unmatched
 * is preserved as a free-text "your reply" tail.
 */
function decomposeSettledAnswer(
  settled: string,
  options: string[],
): { matched: string[]; remainder: string } {
  const trimmed = settled.trim();
  if (!trimmed) {
    return { matched: [], remainder: "" };
  }
  const lowerToCanonical = new Map(
    options.map((opt) => [opt.toLowerCase(), opt] as const),
  );
  const fragments = trimmed
    .split(MULTI_SELECT_JOIN)
    .map((s) => s.trim())
    .filter(Boolean);
  const matched: string[] = [];
  const leftovers: string[] = [];
  for (const frag of fragments) {
    const canonical = lowerToCanonical.get(frag.toLowerCase());
    if (canonical && !matched.includes(canonical)) {
      matched.push(canonical);
    } else {
      leftovers.push(frag);
    }
  }
  // Single non-multi answers (no join char) follow the same matching rule.
  if (matched.length === 0 && fragments.length === 1) {
    const direct = lowerToCanonical.get(trimmed.toLowerCase());
    if (direct) {
      return { matched: [direct], remainder: "" };
    }
  }
  return { matched, remainder: leftovers.join(MULTI_SELECT_JOIN) };
}

interface AskUserPromptProps {
  /** The ``ask_user`` tool call to render. */
  toolCall: ToolCall;
  /**
   * Submit the selected/typed answer. The parent is expected to push the
   * text as a normal user message; OpenPawlet will route it back as the
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
 * Two modes:
 *   - **Single-select** (default): one click on an option submits it
 *     immediately. Optimised for the common "pick one" prompt.
 *   - **Multi-select**: toggle the checklist icon, tick any number of
 *     options, optionally append a custom note, then "Submit". The chosen
 *     labels are joined with the Chinese enumeration comma "、" so the
 *     downstream agent receives one human-readable string as the
 *     ``ask_user`` tool result.
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
  const [multiSelect, setMultiSelect] = useState(false);
  const [pickedOptions, setPickedOptions] = useState<string[]>([]);

  const settledAnswer =
    submittedValue ??
    (typeof toolCall.result === "string" && toolCall.result.trim()
      ? toolCall.result.trim()
      : answeredText ?? null);

  const isLocked = disabled === true || settledAnswer !== null;

  // For locked cards (already answered), parse the stored answer back into
  // matched options + free-text tail so we can render the same green check
  // marks the user originally saw.
  const { matched: settledMatchedOptions, remainder: settledRemainder } =
    useMemo(() => {
      if (!settledAnswer) {
        return { matched: [], remainder: "" };
      }
      return decomposeSettledAnswer(settledAnswer, options);
    }, [settledAnswer, options]);

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || isLocked) {
      return;
    }
    setSubmittedValue(trimmed);
    onAnswer(trimmed);
  };

  const togglePick = (option: string) => {
    setPickedOptions((prev) =>
      prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option],
    );
  };

  const submitMulti = () => {
    if (isLocked) {
      return;
    }
    // Preserve display order as offered by the agent — feels more natural
    // than the click order the user happened to use.
    const ordered = options.filter((o) => pickedOptions.includes(o));
    const customTail = customText.trim();
    const parts = customTail ? [...ordered, customTail] : ordered;
    if (parts.length === 0) {
      return;
    }
    submit(parts.join(MULTI_SELECT_JOIN));
  };

  const canSubmitMulti =
    !isLocked && (pickedOptions.length > 0 || customText.trim().length > 0);

  return (
    <div className="rounded-lg ring-1 ring-sky-200/80 dark:ring-sky-700/45 bg-gradient-to-br from-sky-50/90 to-white dark:from-sky-950/40 dark:to-gray-900/40 px-4 py-3.5 shadow-sm">
      <div className="flex items-start gap-2.5">
        <div className="mt-0.5 shrink-0 inline-flex h-6 w-6 items-center justify-center rounded-full bg-sky-100 dark:bg-sky-900/50 text-sky-600 dark:text-sky-300">
          <QuestionCircleOutlined aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-sky-700/90 dark:text-sky-300/90">
              {t("chat.askUserBadge")}
            </span>
            {isLocked ? (
              <span className="inline-flex items-center gap-1 text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                <CheckOutlined aria-hidden />
                {t("chat.askUserAnswered")}
              </span>
            ) : null}
            {!isLocked && options.length > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setMultiSelect((prev) => !prev);
                  // Switching out of multi-select drops staged picks so the
                  // single-click flow doesn't accidentally inherit them.
                  if (multiSelect) {
                    setPickedOptions([]);
                  }
                }}
                className={[
                  "ml-auto inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10.5px] font-medium transition-colors",
                  multiSelect
                    ? "border-sky-400/80 bg-sky-100/80 text-sky-700 dark:bg-sky-900/50 dark:text-sky-200 dark:border-sky-600/55"
                    : "border-slate-200/80 dark:border-slate-700/60 text-slate-500 dark:text-slate-400 hover:border-sky-300 hover:text-sky-700 dark:hover:text-sky-200",
                ].join(" ")}
                title={t("chat.askUserMultiSelectToggleHint")}
              >
                <UnorderedListOutlined aria-hidden />
                {multiSelect
                  ? t("chat.askUserMultiSelectOn")
                  : t("chat.askUserMultiSelectOff")}
              </button>
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
            const isStagedMulti =
              !isLocked && multiSelect && pickedOptions.includes(option);
            const isSettledHit = isLocked && settledMatchedOptions.includes(option);
            const isSelected = isStagedMulti || isSettledHit;
            const isDimmed = isLocked && !isSelected;
            const onClick = () => {
              if (isLocked) return;
              if (multiSelect) {
                togglePick(option);
              } else {
                submit(option);
              }
            };
            return (
              <button
                key={`${idx}-${option}`}
                type="button"
                onClick={onClick}
                disabled={isLocked}
                aria-pressed={multiSelect ? isStagedMulti : undefined}
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
                    "shrink-0 inline-flex h-4 w-4 items-center justify-center text-[10px] font-semibold ring-1 ring-inset transition-colors",
                    multiSelect && !isLocked ? "rounded-[3px]" : "rounded-full",
                    isSelected
                      ? "bg-emerald-500 text-white ring-emerald-500"
                      : isDimmed
                        ? "bg-slate-100 dark:bg-slate-800 text-slate-400 ring-slate-200/70 dark:ring-slate-700/60"
                        : "bg-sky-50 dark:bg-sky-900/45 text-sky-700 dark:text-sky-300 ring-sky-200/70 dark:ring-sky-700/50 group-hover/opt:bg-sky-100 dark:group-hover/opt:bg-sky-800/60",
                  ].join(" ")}
                >
                  {isSelected ? (
                    <CheckOutlined aria-hidden />
                  ) : multiSelect && !isLocked ? (
                    ""
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
                  if (multiSelect) {
                    submitMulti();
                  } else {
                    submit(customText);
                  }
                }
              }}
              placeholder={
                multiSelect
                  ? t("chat.askUserCustomNotePlaceholder")
                  : t("chat.askUserCustomPlaceholder")
              }
              className="w-full rounded-md border border-slate-200/80 dark:border-slate-700/60 bg-white dark:bg-gray-900/55 px-3 py-1.5 pr-10 text-[12.5px] text-slate-800 dark:text-slate-100 placeholder:text-slate-400 dark:placeholder:text-slate-500 outline-none focus:border-sky-400/85 focus:ring-2 focus:ring-sky-200/70 dark:focus:ring-sky-700/40 transition-colors"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] font-medium text-slate-300 dark:text-slate-500">
              <EnterOutlined aria-hidden />
            </span>
          </div>
          <button
            type="button"
            onClick={() => (multiSelect ? submitMulti() : submit(customText))}
            disabled={
              multiSelect ? !canSubmitMulti : !customText.trim()
            }
            className="shrink-0 rounded-md bg-sky-500 px-3 py-1.5 text-[12.5px] font-medium text-white shadow-sm shadow-sky-500/25 transition-colors hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-sky-500"
          >
            {multiSelect && pickedOptions.length > 0
              ? t("chat.askUserSubmitWithCount", {
                  count: pickedOptions.length + (customText.trim() ? 1 : 0),
                })
              : t("chat.askUserSubmit")}
          </button>
        </div>
      ) : settledRemainder ? (
        <div className="mt-3 rounded-md border border-emerald-200/70 dark:border-emerald-800/55 bg-emerald-50/80 dark:bg-emerald-950/30 px-3 py-2 text-[12.5px] text-emerald-900 dark:text-emerald-100">
          <span className="font-medium mr-1.5">
            {t("chat.askUserYourReply")}:
          </span>
          <span className="break-words">{settledRemainder}</span>
        </div>
      ) : null}
    </div>
  );
}

/** Identify ``ask_user`` agent calls so callers can swap in a custom UI. */
export function isAskUserToolCall(tc: ToolCall): boolean {
  return typeof tc.name === "string" && tc.name === "ask_user";
}
