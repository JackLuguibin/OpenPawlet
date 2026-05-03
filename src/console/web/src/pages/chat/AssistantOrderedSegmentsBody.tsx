import { Markdown } from "../../components/Markdown";
import { MessageThinkingBlock } from "./MessageThinkingBlock";
import { MessageToolCallsBlock } from "./MessageToolCalls";
import type { AssistantRenderSegment } from "./types";

interface AssistantOrderedSegmentsBodyProps {
  segments: AssistantRenderSegment[];
  onAskUserAnswer?: (text: string) => void;
  askUserDisabled?: boolean;
}

/**
 * Renders one grouped assistant bubble in transcript arrival order instead of a
 * single tools block pinned above all markdown.
 */
export function AssistantOrderedSegmentsBody({
  segments,
  onAskUserAnswer,
  askUserDisabled,
}: AssistantOrderedSegmentsBodyProps) {
  const visible = segments.filter((s) => {
    if (s.type === "reasoning") {
      return typeof s.text === "string" && s.text.trim().length > 0;
    }
    if (s.type === "text") {
      return typeof s.content === "string" && s.content.trim().length > 0;
    }
    return (s.tool_calls?.length ?? 0) > 0;
  });

  return (
    <div className="min-w-0 w-full">
      {visible.map((seg, idx) => {
        const topRule =
          idx > 0
            ? "mt-3 pt-3 border-t border-gray-100 dark:border-gray-700"
            : "";

        switch (seg.type) {
          case "reasoning": {
            return (
              <div key={`thinking-${idx}`} className={topRule}>
                <MessageThinkingBlock text={seg.text} />
              </div>
            );
          }
          case "text": {
            return (
              <div
                key={`text-${idx}`}
                className={`max-w-none min-w-0 w-full break-anywhere text-[15px] leading-relaxed text-gray-900 dark:text-gray-100 ${topRule}`}
              >
                <div className="prose prose-sm max-w-none min-w-0 w-full dark:prose-invert break-anywhere">
                  <Markdown>{seg.content}</Markdown>
                </div>
              </div>
            );
          }
          case "tools": {
            return (
              <div key={`tools-${idx}`} className={topRule}>
                <MessageToolCallsBlock
                  noTopMargin
                  tool_calls={seg.tool_calls}
                  onAskUserAnswer={onAskUserAnswer}
                  askUserDisabled={askUserDisabled}
                />
              </div>
            );
          }
          default:
            return null;
        }
      })}
    </div>
  );
}
