import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { TFunction } from "i18next";

import * as api from "../../api/client";
import type { Message } from "./types";

/**
 * Page size for the lazy-loaded chat history.
 *
 * The first request asks the backend `/transcript` endpoint for the most
 * recent `CHAT_HISTORY_PAGE_SIZE` messages; scrolling to the top fetches the
 * previous page. Keep this modest so the first render of a long conversation
 * stays fast; users scrolling up pay a single round-trip for older context.
 */
export const CHAT_HISTORY_PAGE_SIZE = 80;

/** Pixel distance from the container's top that triggers a prev-page fetch. */
export const CHAT_HISTORY_TOP_TRIGGER_PX = 120;

interface AddToast {
  (toast: { type: "error" | "info" | "success" | "warning"; message: string }): void;
}

interface UseChatHistoryPagingParams {
  activeSessionKey: string | null | undefined;
  currentBotId: string | null;
  /** Stable id used as React key + virtualization height-cache lookup. */
  buildStableMessageId: (msg: Message, absoluteIndex: number) => string;
  /** Apply the prepended page to the current chat list. */
  setMessages: Dispatch<SetStateAction<Message[]>>;
  addToast: AddToast;
  t: TFunction;
}

export interface UseChatHistoryPagingResult {
  /**
   * Absolute index (into the full transcript) of the oldest message currently
   * loaded in `messages`. `null` when pagination metadata is unavailable
   * (transcript endpoint returned the legacy full-history shape).
   */
  historyOldestOffset: number | null;
  setHistoryOldestOffset: Dispatch<SetStateAction<number | null>>;
  /** True when the server reports more messages exist before `historyOldestOffset`. */
  historyHasMore: boolean;
  setHistoryHasMore: Dispatch<SetStateAction<boolean>>;
  /** Drives the "loading older" hint at the top of the list. */
  loadingOlder: boolean;
  /**
   * Mirrors `loadingOlder` so the scroll handler can guard against concurrent
   * page fetches without tying its `useCallback` to the render-tied state.
   */
  loadingOlderRef: React.MutableRefObject<boolean>;
  /**
   * Fetch one previous page (the `CHAT_HISTORY_PAGE_SIZE` messages immediately
   * before `historyOldestOffset`) and prepend it to `messages`. No-ops when
   * already loading, when no older history exists, or when the page is in the
   * "draft session" state with no transcript yet.
   *
   * The function also restores the scroll position after the prepend so the
   * viewport appears frozen in place rather than jumping up to the new top.
   */
  loadOlderHistoryPage: () => Promise<void>;
}

/**
 * Manages "load older history" pagination for the chat timeline.
 *
 * Why a hook rather than a few `useState`s inline: the four pieces (offset,
 * hasMore, loadingOlder + ref, the async loader) are tightly coupled. Pulling
 * them out lets the hook own the invariant that `loadingOlderRef` always
 * mirrors `loadingOlder`, and lets `Chat.tsx` keep using `setHistoryOldest*`
 * directly to seed pagination from the initial transcript fetch.
 */
export function useChatHistoryPaging({
  activeSessionKey,
  currentBotId,
  buildStableMessageId,
  setMessages,
  addToast,
  t,
}: UseChatHistoryPagingParams): UseChatHistoryPagingResult {
  const [historyOldestOffset, setHistoryOldestOffset] = useState<number | null>(
    null,
  );
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);

  const loadOlderHistoryPage = useCallback(async () => {
    if (loadingOlderRef.current) return;
    if (!historyHasMore) return;
    if (!activeSessionKey) return;
    if (historyOldestOffset === null || historyOldestOffset <= 0) return;

    loadingOlderRef.current = true;
    setLoadingOlder(true);

    // Find the scroll parent the virtual list mounted; it owns the scroll
    // offset we need to restore after prepending rows.
    const scroller = document.querySelector<HTMLDivElement>(
      '[data-testid="chat-virtual-scroll"]',
    );
    const prevScrollHeight = scroller?.scrollHeight ?? 0;
    const prevScrollTop = scroller?.scrollTop ?? 0;

    try {
      const page = await api.getSessionTranscript(
        activeSessionKey,
        currentBotId,
        {
          limit: CHAT_HISTORY_PAGE_SIZE,
          beforeIndex: historyOldestOffset,
        },
      );
      const older = (page.messages ?? []) as Message[];
      const newOldestOffset =
        typeof page.offset === "number" ? page.offset : 0;
      const nextHasMore = Boolean(page.has_more);

      if (older.length > 0) {
        setMessages((prev) => {
          const prepended: Message[] = older.map((msg, idx) => ({
            ...msg,
            id: buildStableMessageId(msg, newOldestOffset + idx),
          }));
          return [...prepended, ...prev];
        });
      }
      setHistoryOldestOffset(newOldestOffset);
      setHistoryHasMore(nextHasMore);

      // Restore scroll position after layout settles. Using requestAnimation-
      // Frame twice ensures measurement + paint have both flushed so the
      // growth we add is the final value.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!scroller) return;
          const growth = scroller.scrollHeight - prevScrollHeight;
          if (growth > 0) {
            scroller.scrollTop = prevScrollTop + growth;
          }
        });
      });
    } catch (err) {
      addToast({
        type: "error",
        message:
          err instanceof Error
            ? `${t("chat.loadOlderFailed")}: ${err.message}`
            : t("chat.loadOlderFailed"),
      });
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [
    historyHasMore,
    historyOldestOffset,
    activeSessionKey,
    currentBotId,
    buildStableMessageId,
    setMessages,
    addToast,
    t,
  ]);

  return {
    historyOldestOffset,
    setHistoryOldestOffset,
    historyHasMore,
    setHistoryHasMore,
    loadingOlder,
    loadingOlderRef,
    loadOlderHistoryPage,
  };
}
