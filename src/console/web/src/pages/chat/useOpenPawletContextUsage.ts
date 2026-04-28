import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

import { parseOpenPawletStatusJson } from "./statusParse";
import type { OpenPawletContextUsage } from "./types";

/**
 * Inputs the chat page must hand over so the hook can track the OpenPawlet
 * `/status-json` lifecycle without re-implementing WebSocket plumbing.
 */
interface UseOpenPawletContextUsageParams {
  useOpenPawletChannel: boolean;
  openpawletWsReady: boolean;
  currentBotId: string | null;
  sendOpenPawletMessage: (payload: { content: string; botId: string | null }) => void;
  /**
   * Which session the page is currently bound to. Each change advances an
   * internal epoch so a stale `/status-json` reply for a previous session
   * cannot overwrite the new session's metric.
   */
  activeSessionKey: string | null | undefined;
}

/**
 * Outputs surfaced back to the page. The refs are intentionally exported so
 * `handleStreamChunk` (the WebSocket fan-out reducer that still lives in
 * `Chat.tsx`) can keep its inline branching for `silent` polls without us
 * also having to migrate every WebSocket frame type into this hook.
 */
export interface UseOpenPawletContextUsageResult {
  /** Latest parsed `{tokens_estimate, window_total, percent_used}` or null. */
  openpawletContextUsage: OpenPawletContextUsage | null;
  /** Setter exposed for inline parses in `chat_token`/`channel_notice` paths. */
  setOpenPawletContextUsage: (next: OpenPawletContextUsage | null) => void;
  /** Drives the input's `contextLoading` chip while a silent poll is in-flight. */
  statusJsonLoading: boolean;
  /**
   * Send a `/status-json` command on the OpenPawlet WebSocket. Caller is expected
   * to invoke this:
   * - Once after each `ready` (handled internally via the effect we own);
   * - After each turn finishes (caller hooks this into `chat_done`).
   */
  scheduleOpenPawletStatusJson: () => void;
  /**
   * True while the WS reducer should swallow streamed frames into the
   * `/status-json` buffer instead of rendering them.
   */
  silentStatusJsonRef: MutableRefObject<boolean>;
  /** Aggregated text seen so far for the in-flight silent `/status-json` poll. */
  silentStatusJsonBufferRef: MutableRefObject<string>;
  /**
   * True after an early-parse (status payload was extracted before
   * `chat_done`); the WS reducer should drop the upcoming empty `chat_done`
   * frame so the timeline does not gain a phantom blank assistant bubble.
   */
  expectStatusJsonTrailingChatDoneRef: MutableRefObject<boolean>;
  /**
   * Conclude the in-flight silent poll: parse the assembled buffer (or `raw`
   * passed by the caller) and reset the refs/state. When `fromEarlyParse` is
   * set, the hook arms `expectStatusJsonTrailingChatDoneRef` so the upcoming
   * empty `chat_done` is suppressed.
   */
  completeSilentStatusJsonPoll: (
    raw: string,
    options?: { fromEarlyParse?: boolean },
  ) => void;
}

/**
 * Hook for the silent `/status-json` poll machinery.
 *
 * Why a hook (and not a few `useState`s inline): the four refs and three
 * state slots are tightly coupled by a small state machine — any caller that
 * needs to mutate one of them in isolation will inevitably break the rest.
 * Bundling them lets us keep the contract in one place while leaving
 * `handleStreamChunk` (which has many other branches) untouched.
 */
export function useOpenPawletContextUsage({
  useOpenPawletChannel,
  openpawletWsReady,
  currentBotId,
  sendOpenPawletMessage,
  activeSessionKey,
}: UseOpenPawletContextUsageParams): UseOpenPawletContextUsageResult {
  const [openpawletContextUsage, setOpenPawletContextUsage] =
    useState<OpenPawletContextUsage | null>(null);
  const [statusJsonLoading, setStatusJsonLoading] = useState(false);

  const silentStatusJsonRef = useRef(false);
  const silentStatusJsonBufferRef = useRef("");
  const statusJsonInFlightRef = useRef(false);
  const queuedStatusJsonRef = useRef(false);
  /** Incremented when `activeSessionKey` changes so stale replies are ignored. */
  const contextSessionEpochRef = useRef(0);
  const statusJsonPollEpochRef = useRef(0);
  const expectStatusJsonTrailingChatDoneRef = useRef(false);

  useEffect(() => {
    contextSessionEpochRef.current += 1;
    setOpenPawletContextUsage(null);
    silentStatusJsonRef.current = false;
    silentStatusJsonBufferRef.current = "";
    statusJsonInFlightRef.current = false;
    queuedStatusJsonRef.current = false;
    setStatusJsonLoading(false);
    expectStatusJsonTrailingChatDoneRef.current = false;
  }, [activeSessionKey]);

  const scheduleOpenPawletStatusJson = useCallback(() => {
    if (!useOpenPawletChannel || !openpawletWsReady) {
      return;
    }
    if (statusJsonInFlightRef.current) {
      queuedStatusJsonRef.current = true;
      return;
    }
    statusJsonInFlightRef.current = true;
    silentStatusJsonRef.current = true;
    silentStatusJsonBufferRef.current = "";
    statusJsonPollEpochRef.current = contextSessionEpochRef.current;
    setStatusJsonLoading(true);
    try {
      sendOpenPawletMessage({
        content: "/status-json",
        botId: currentBotId,
      });
    } catch {
      statusJsonInFlightRef.current = false;
      silentStatusJsonRef.current = false;
      setStatusJsonLoading(false);
      if (queuedStatusJsonRef.current) {
        queuedStatusJsonRef.current = false;
        queueMicrotask(() => scheduleOpenPawletStatusJson());
      }
    }
  }, [useOpenPawletChannel, openpawletWsReady, currentBotId, sendOpenPawletMessage]);

  const completeSilentStatusJsonPoll = useCallback(
    (raw: string, options?: { fromEarlyParse?: boolean }) => {
      const epochOk =
        statusJsonPollEpochRef.current === contextSessionEpochRef.current;
      silentStatusJsonBufferRef.current = "";
      silentStatusJsonRef.current = false;
      statusJsonInFlightRef.current = false;
      setStatusJsonLoading(false);
      if (options?.fromEarlyParse) {
        expectStatusJsonTrailingChatDoneRef.current = true;
      }
      if (epochOk) {
        const parsed = parseOpenPawletStatusJson(raw);
        if (parsed) {
          setOpenPawletContextUsage(parsed);
        }
      }
      if (queuedStatusJsonRef.current) {
        queuedStatusJsonRef.current = false;
        queueMicrotask(() => scheduleOpenPawletStatusJson());
      }
    },
    [scheduleOpenPawletStatusJson],
  );

  // After each `ready` (initial connect + reconnects), refresh context.
  useEffect(() => {
    if (!useOpenPawletChannel || !openpawletWsReady) {
      return;
    }
    scheduleOpenPawletStatusJson();
  }, [useOpenPawletChannel, openpawletWsReady, scheduleOpenPawletStatusJson]);

  return {
    openpawletContextUsage,
    setOpenPawletContextUsage,
    statusJsonLoading,
    scheduleOpenPawletStatusJson,
    silentStatusJsonRef,
    silentStatusJsonBufferRef,
    expectStatusJsonTrailingChatDoneRef,
    completeSilentStatusJsonPoll,
  };
}
