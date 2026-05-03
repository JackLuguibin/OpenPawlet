import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Lightweight windowed renderer for the chat message list.
 *
 * Why a hand-rolled virtualization instead of a library:
 *
 * - Messages have strongly variable heights (markdown, thinking block, tool
 *   calls). Fixed-height virtualization is a non-starter.
 * - Adding a dependency (@tanstack/react-virtual / react-window) felt heavier
 *   than the 150-line implementation below; we already own the scroll
 *   container (`scrollParentRef`) so we can do measurement + offset math
 *   ourselves.
 * - Anchor restoration on prepending (for lazy-loading older history) is
 *   trivial because we keep a single scroll parent and compute offsets from
 *   measured row heights.
 *
 * Contract:
 *
 * - `items` is the full list the parent wants displayed (oldest → newest).
 *   Keys come from `getKey(item, index)`; stable keys are mandatory, otherwise
 *   height caches for the wrong row would be used after prepending.
 * - `renderItem(item, index)` must return a single block-level element. The
 *   height of that block is measured via ResizeObserver and cached by key.
 * - `footer` is rendered after the virtual items and is NOT virtualized. Use
 *   it for the streaming tail bubble, typing dots, etc.
 * - Rows outside the viewport are replaced by two padding spacers
 *   (`topSpacer`, `bottomSpacer`) so the scroll height matches the full list
 *   while the DOM stays bounded to `overscan` rows above + `overscan` rows
 *   below the visible window.
 */
export interface VirtualizedMessageListProps<T> {
  items: T[];
  getKey: (item: T, index: number) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Content rendered after all virtual rows (e.g. streaming tail). */
  footer?: ReactNode;
  /** Content rendered before all virtual rows (e.g. "loading older" hint). */
  header?: ReactNode;
  /** Extra rows to keep mounted above/below the viewport. Default 4. */
  overscan?: number;
  /** Initial guess for row height before measurement. */
  estimatedRowHeight?: number;
  /** Spacing between rows (matches previous `space-y-4`). */
  gapPx?: number;
  /** Optional inner wrapper className for measurement purposes. */
  className?: string;
  /**
   * Imperative handle setter; receives `{ scrollToBottom, isNearBottom }` so
   * the parent can drive programmatic scrolling when streaming updates arrive.
   */
  registerHandle?: (handle: VirtualMessageListHandle | null) => void;
}

export interface VirtualMessageListHandle {
  /** Scroll the parent to the bottom (behavior: "auto" by default). */
  scrollToBottom: (smooth?: boolean) => void;
  /** True when the viewport sits within the configured near-bottom threshold. */
  isNearBottom: () => boolean;
  /** Read current distance to the bottom in CSS pixels. */
  distanceFromBottom: () => number;
}

const DEFAULT_ESTIMATED_ROW = 180;
const DEFAULT_OVERSCAN = 4;
const DEFAULT_GAP = 16;

export function VirtualizedMessageList<T>({
  items,
  getKey,
  renderItem,
  footer,
  header,
  overscan = DEFAULT_OVERSCAN,
  estimatedRowHeight = DEFAULT_ESTIMATED_ROW,
  gapPx = DEFAULT_GAP,
  className,
  registerHandle,
}: VirtualizedMessageListProps<T>) {
  const scrollParentRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const headerRef = useRef<HTMLDivElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);

  /** key → measured offsetHeight. */
  const heightsRef = useRef<Map<string, number>>(new Map());
  /** key → ResizeObserver entry (one observer per mounted row). */
  const rowObserversRef = useRef<Map<string, ResizeObserver>>(new Map());

  const [viewportHeight, setViewportHeight] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  /** Bump to force recompute when a row's measured height changes. */
  const [measurementVersion, setMeasurementVersion] = useState(0);

  const keys = useMemo(
    () => items.map((item, index) => getKey(item, index)),
    [items, getKey],
  );

  /**
   * Cumulative offsets computed from cached heights (estimate fallback).
   * offsets[i] = distance from the top of the list to row i's top edge
   * (including the `gapPx` between neighbouring rows).
   */
  const offsets = useMemo(() => {
    // measurementVersion is only read to keep the memo fresh; the real input
    // lives in heightsRef (a mutable Map) which React cannot diff.
    void measurementVersion;
    const result = new Array<number>(keys.length + 1);
    result[0] = 0;
    const heights = heightsRef.current;
    for (let i = 0; i < keys.length; i++) {
      const h = heights.get(keys[i]) ?? estimatedRowHeight;
      const gap = i === 0 ? 0 : gapPx;
      result[i + 1] = result[i] + gap + h;
    }
    return result;
  }, [keys, estimatedRowHeight, gapPx, measurementVersion]);

  const totalHeight = offsets[offsets.length - 1] ?? 0;

  /**
   * Binary search for the first row whose bottom is >= `y`. Used to convert
   * viewport Y coordinates to row indices.
   */
  const findRowIndexAtOffset = useCallback(
    (y: number): number => {
      if (offsets.length <= 1) return 0;
      let lo = 0;
      let hi = offsets.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (offsets[mid + 1] <= y) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      return lo;
    },
    [offsets],
  );

  const { startIndex, endIndex } = useMemo(() => {
    if (keys.length === 0) {
      return { startIndex: 0, endIndex: 0 };
    }
    const viewportTop = scrollTop;
    const viewportBottom = scrollTop + viewportHeight;
    const first = findRowIndexAtOffset(viewportTop);
    const last = findRowIndexAtOffset(viewportBottom);
    const s = Math.max(0, first - overscan);
    const e = Math.min(keys.length, last + 1 + overscan);
    return { startIndex: s, endIndex: e };
  }, [keys.length, scrollTop, viewportHeight, findRowIndexAtOffset, overscan]);

  const topSpacer = offsets[startIndex] ?? 0;
  const bottomSpacer = Math.max(0, totalHeight - (offsets[endIndex] ?? 0));

  /**
   * Stable row ref setter. The same function identity is reused across
   * renders so we don't churn ResizeObservers; instead we install/remove
   * per-row based on whether the ref callback receives an element.
   */
  const measureRowCallback = useCallback(
    (key: string) => (node: HTMLDivElement | null) => {
      const observers = rowObserversRef.current;
      const heights = heightsRef.current;
      const existing = observers.get(key);
      if (existing) {
        existing.disconnect();
        observers.delete(key);
      }
      if (!node) {
        return;
      }

      const record = (height: number) => {
        if (!Number.isFinite(height) || height <= 0) return;
        const prev = heights.get(key);
        // Round to the nearest px; sub-pixel jitter from ResizeObserver
        // would otherwise trigger constant recomputes during streaming.
        const next = Math.round(height);
        if (prev !== undefined && Math.abs(prev - next) < 1) {
          return;
        }
        heights.set(key, next);
        setMeasurementVersion((v) => v + 1);
      };

      record(node.offsetHeight);

      const observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          record((entry.target as HTMLElement).offsetHeight);
        }
      });
      observer.observe(node);
      observers.set(key, observer);
    },
    [],
  );

  // Keep viewport metrics in sync with container resize.
  useLayoutEffect(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    const update = () => {
      setViewportHeight(el.clientHeight);
      setScrollTop(el.scrollTop);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollParentRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
  }, []);

  // Expose imperative handle synchronously after DOM commit so parents can
  // rely on scroll helpers in layout effects without missing the first paint.
  useLayoutEffect(() => {
    if (!registerHandle) return undefined;
    const handle: VirtualMessageListHandle = {
      scrollToBottom: (smooth = false) => {
        const el = scrollParentRef.current;
        if (!el) return;
        el.scrollTo({
          top: el.scrollHeight,
          behavior: smooth ? "smooth" : "auto",
        });
      },
      isNearBottom: () => {
        const el = scrollParentRef.current;
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight <= 100;
      },
      distanceFromBottom: () => {
        const el = scrollParentRef.current;
        if (!el) return 0;
        return el.scrollHeight - el.scrollTop - el.clientHeight;
      },
    };
    registerHandle(handle);
    return () => registerHandle(null);
  }, [registerHandle]);

  // Drop height entries for keys no longer present (old sessions, deletes).
  useEffect(() => {
    const present = new Set(keys);
    const heights = heightsRef.current;
    let changed = false;
    for (const k of Array.from(heights.keys())) {
      if (!present.has(k)) {
        heights.delete(k);
        changed = true;
      }
    }
    if (changed) {
      setMeasurementVersion((v) => v + 1);
    }
  }, [keys]);

  const visibleKeys = keys.slice(startIndex, endIndex);

  return (
    <div
      ref={scrollParentRef}
      onScroll={handleScroll}
      data-testid="chat-virtual-scroll"
      className="flex-1 min-h-0 overflow-y-auto chat-message-scroll px-4 md:px-6 py-2 md:py-3"
    >
      <div
        ref={listRef}
        className={`w-full min-w-0 max-w-3xl mx-auto ${className ?? ""}`.trim()}
      >
        {header ? (
          <div ref={headerRef} className="mb-4">
            {header}
          </div>
        ) : null}

        {keys.length > 0 ? (
          <div style={{ position: "relative" }}>
            <div style={{ height: topSpacer }} aria-hidden />
            {visibleKeys.map((key, localIdx) => {
              const absoluteIdx = startIndex + localIdx;
              const item = items[absoluteIdx];
              if (!item) return null;
              return (
                <div
                  key={key}
                  ref={measureRowCallback(key)}
                  style={{ marginTop: absoluteIdx === 0 ? 0 : gapPx }}
                  data-row-key={key}
                >
                  {renderItem(item, absoluteIdx)}
                </div>
              );
            })}
            <div style={{ height: bottomSpacer }} aria-hidden />
          </div>
        ) : null}

        {footer ? (
          <div ref={footerRef} style={{ marginTop: keys.length > 0 ? gapPx : 0 }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

