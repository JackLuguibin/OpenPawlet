import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import { RobotOutlined, ThunderboltOutlined } from "@ant-design/icons";

/** One actionable prompt rendered as a suggestion card on the empty timeline. */
export interface ChatSuggestion {
  /** Full prompt text that fills the composer when the card is clicked. */
  text: string;
  /** Short summary shown on the card. */
  label: string;
}

interface ChatHeroSuggestionsProps {
  suggestions: ChatSuggestion[];
  /** Invoked with the raw `text` of the picked suggestion. */
  onPickSuggestion: (text: string) => void;
  /** Forwarded to the outer scroll container so existing scroll plumbing keeps working. */
  containerRef: Ref<HTMLDivElement>;
}

/**
 * Empty-state hero shown when there are no rendered messages yet.
 *
 * The component is intentionally pure: the parent owns the suggestion list
 * (memoized via i18n keys) and the side effect of pushing text into the
 * composer + focusing the textarea. We only render and dispatch.
 */
export function ChatHeroSuggestions({
  suggestions,
  onPickSuggestion,
  containerRef,
}: ChatHeroSuggestionsProps) {
  const { t } = useTranslation();
  return (
    <div
      ref={containerRef}
      className="flex-1 min-h-0 overflow-y-auto chat-message-scroll px-4 md:px-6 py-2 md:py-3"
    >
      <div className="min-h-full flex flex-col items-center justify-start pt-2 md:pt-4 text-center text-gray-600 dark:text-gray-300">
        <div className="w-20 h-20 rounded-md bg-blue-50 dark:bg-blue-900/20 flex items-center justify-center mb-6 text-blue-600 dark:text-blue-400">
          <RobotOutlined style={{ fontSize: 36 }} />
        </div>
        <h3 className="text-2xl font-semibold mb-3 text-gray-900 dark:text-white">
          {t("chat.heroTitle")}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-8 max-w-md">
          {t("chat.heroSubtitle")}
        </p>
        <div className="grid gap-3 w-full max-w-xl">
          {suggestions.map((suggestion, idx) => (
            <button
              key={idx}
              onClick={() => onPickSuggestion(suggestion.text)}
              className="flex items-center justify-between px-5 py-4 rounded-md bg-white dark:bg-gray-800 shadow-sm hover:shadow-md border border-gray-100 dark:border-gray-700 text-left text-sm transition-shadow duration-200 group"
            >
              <div className="flex items-center gap-3">
                <ThunderboltOutlined className="text-blue-500" />
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
  );
}
