import type { Components } from "react-markdown";

/** GFM pipe tables: stay within container width; long tokens wrap instead of overflowing. */
export const markdownGfmTableComponents: Partial<Components> = {
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
