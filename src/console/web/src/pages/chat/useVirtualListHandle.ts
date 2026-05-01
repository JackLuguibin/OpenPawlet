import { useCallback, useRef, useState, type RefObject } from "react";
import type { VirtualMessageListHandle } from "./VirtualizedMessageList";

/**
 * Convenience hook: parent components that only want a ref-like handle can
 * pass this hook's return value to `<VirtualizedMessageList registerHandle />`
 * and call the handle's methods through the returned `{ current }` shape.
 *
 * `epoch` increments whenever the list registers or clears its imperative
 * handle so parent effects/layout hooks can reliably run after `ref.current`
 * is populated (silent ref mutations would not rerender otherwise).
 *
 * Kept in its own module so the component file stays "components only" and
 * plays well with React Refresh's export-only-components rule.
 */
export function useVirtualListHandle(): readonly [
  RefObject<VirtualMessageListHandle | null>,
  (handle: VirtualMessageListHandle | null) => void,
  number,
] {
  const ref = useRef<VirtualMessageListHandle | null>(null);
  const [epoch, setEpoch] = useState(0);
  const setter = useCallback((handle: VirtualMessageListHandle | null) => {
    ref.current = handle;
    setEpoch((n) => n + 1);
  }, []);
  return [ref, setter, epoch] as const;
}
