import type { ComponentProps } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

type MarkdownProps = ComponentProps<typeof ReactMarkdown>;

/** GFM pipe tables: stay within container width; long tokens wrap instead of overflowing. */
const gfmTableComponents: Partial<Components> = {
  table: ({ children, className, ...props }) => (
    <div className="w-full min-w-0 max-w-full">
      <table
        {...props}
        className={[className, "w-full min-w-0 table-fixed border-collapse"].filter(Boolean).join(" ")}
      >
        {children}
      </table>
    </div>
  ),
  th: ({ children, className, ...props }) => (
    <th
      {...props}
      className={
        [className, "min-w-0 align-top break-all whitespace-normal [&_code]:whitespace-normal [&_code]:break-all"]
          .filter(Boolean)
          .join(" ") || undefined
      }
    >
      {children}
    </th>
  ),
  td: ({ children, className, ...props }) => (
    <td
      {...props}
      className={
        [className, "min-w-0 align-top break-all whitespace-normal [&_code]:whitespace-normal [&_code]:break-all"]
          .filter(Boolean)
          .join(" ") || undefined
      }
    >
      {children}
    </td>
  ),
};

/**
 * Markdown renderer with GFM (pipe tables, strikethrough, task lists, autolinks).
 * Plain `react-markdown` is CommonMark-only and does not parse tables.
 */
export function Markdown({ remarkPlugins, components, ...rest }: MarkdownProps) {
  const mergedComponents = {
    ...gfmTableComponents,
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
