import { useTranslation } from "react-i18next";
import { RightOutlined, ThunderboltOutlined } from "@ant-design/icons";

/**
 * Collapsible "Thinking" section rendered above the assistant body.
 *
 * Source priority on the message:
 * 1. `reasoning_content` (preferred — populated by transcript replay and the
 *    `thinking_content` WS frame).
 * 2. Anthropic `thinking_blocks` lifted into `reasoning_content` by
 *    `normalizeMessageForChatRender`.
 *
 * Returns `null` for empty/whitespace-only text so we never render an empty
 * details element above the bubble.
 */
export function MessageThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation();
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  return (
    <details className="group text-left rounded-md overflow-hidden bg-gradient-to-br from-slate-50/95 to-slate-100/40 dark:from-slate-800/35 dark:to-slate-900/25 ring-1 ring-slate-200/70 dark:ring-slate-600/40 border-l-[3px] border-l-primary-500/85 dark:border-l-primary-400/70 shadow-sm shadow-slate-900/5">
      <summary className="cursor-pointer list-none flex items-center gap-2.5 px-2 py-2.5 [&::-webkit-details-marker]:hidden select-none hover:bg-slate-100/60 dark:hover:bg-white/[0.04] transition-colors">
        <RightOutlined
          className="shrink-0 text-slate-400 dark:text-slate-500 transition-transform duration-200 group-open:rotate-90"
          aria-hidden
        />
        <ThunderboltOutlined
          className="shrink-0 text-blue-600 dark:text-blue-400 opacity-90"
          aria-hidden
        />
        <span className="text-[13px] font-medium text-slate-600 dark:text-slate-300 tracking-tight">
          {t("chat.thinking")}
        </span>
      </summary>
      <div className="px-2 pb-3.5 pt-0">
        <div className="border-t border-slate-200/55 dark:border-slate-600/35 pt-2.5">
          <div className="text-[13px] leading-relaxed text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words max-h-56 overflow-y-auto pr-0.5">
            {trimmed}
          </div>
        </div>
      </div>
    </details>
  );
}
