import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

/**
 * Markdown renderer with GFM (pipe tables, strikethrough, task lists, autolinks).
 * Plain `react-markdown` is CommonMark-only and does not parse tables.
 */
export function Markdown({ remarkPlugins, ...rest }: MarkdownProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
      {...rest}
    />
  );
}
