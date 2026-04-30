import type { ComponentProps } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { markdownGfmTableComponents } from "./markdownGfmTableComponents";

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

/**
 * Markdown renderer with GFM (pipe tables, strikethrough, task lists, autolinks).
 * Plain `react-markdown` is CommonMark-only and does not parse tables.
 */
export function Markdown({ remarkPlugins, components, ...rest }: MarkdownProps) {
  const mergedComponents = {
    ...markdownGfmTableComponents,
    ...(components ?? {}),
  };

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
      components={mergedComponents}
      {...rest}
    />
  );
}
