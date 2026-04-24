import { useCallback, useRef } from "react";
import type { VirtualMessageListHandle } from "./VirtualizedMessageList";

/**
 * Convenience hook: parent components that only want a ref-like handle can
 * pass this hook's return value to `<VirtualizedMessageList registerHandle />`
 * and call the handle's methods through the returned `{ current }` shape.
 *
 * Kept in its own module so the component file stays "components only" and
 * plays well with React Refresh's export-only-components rule.
 */
export function useVirtualListHandle() {
  const ref = useRef<VirtualMessageListHandle | null>(null);
  const setter = useCallback((handle: VirtualMessageListHandle | null) => {
    ref.current = handle;
  }, []);
  return [ref, setter] as const;
}
