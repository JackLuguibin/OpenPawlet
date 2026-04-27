import { useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { LoadingOutlined } from "@ant-design/icons";
import { Square } from "lucide-react";
import Input from "antd/es/input";
import type { TextAreaRef } from "antd/es/input/TextArea";

import { formatCompactTokenCount } from "./statusParse";
import type { NanobotContextUsage } from "./types";

export interface ChatInputProps {
  inputRef: RefObject<TextAreaRef | null>;
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

/**
 * Chat composer: textarea + send/stop button + optional context-window meter.
 *
 * Owns only the local "focused" UI state. Everything else (value, streaming
 * lifecycle, send/stop actions, context usage) is driven by the parent so
 * the input can be replaced without touching the streaming pipeline.
 */
export function ChatInput({
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
          ref={inputRef as RefObject<TextAreaRef>}
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
