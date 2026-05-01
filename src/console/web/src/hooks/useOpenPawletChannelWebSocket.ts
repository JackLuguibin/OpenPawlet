import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { StreamChunk } from "../api/types";
import { useAppStore } from "../store";
import i18n from "../i18n";
import { outboundDataHasStatusContext } from "../utils/openpawletStatusContext";
import {
  mergeToolCallsWithResults,
  normalizeToolCallsArray,
  normalizeToolResultItems,
} from "../utils/toolCalls";

import { dispatchChatChunk } from "./useWebSocket";

/**
 * Latest OpenPawlet socket teardown from `useOpenPawletChannelWebSocket` (e.g. delete flow:
 * disconnect → navigate → DELETE).
 */
const openpawletChannelHardDisconnectRef: { current: (() => void) | null } = {
  current: null,
};

/**
 * Synchronously close the OpenPawlet channel WebSocket, cancel reconnect, and clear
 * link state. Call **before** changing the chat route when the old session must
 * not receive another `ready` (e.g. deleting the current session).
 */
export function disconnectOpenPawletChannelWebSocket(): void {
  openpawletChannelHardDisconnectRef.current?.();
}

/** Frames from `openpawlet.channels.websocket` (WebSocketChannel). */
export interface OpenPawletNativeWsFrame {
  event:
    | "ready"
    | "message"
    /** Structured `/status-json` reply (empty `text`, JSON in `data`). */
    | "status"
    | "delta"
    | "stream_end"
    | "chat_start"
    | "chat_end"
    | "tool_event"
    | "reasoning"
    | string;
  text?: string;
  chat_id?: string;
  client_id?: string;
  /** True when the client resumed via `?chat_id=` (see OpenPawlet WS docs). */
  resumed?: boolean;
  /** From gateway `ready`: agent turn in flight for this `chat_id` (reconnect UX). */
  session_busy?: boolean;
  media?: string[];
  reply_to?: string;
  stream_id?: unknown;
  tool_calls?: unknown;
  reasoning_content?: string;
  /** OutboundMessage.data — may carry status/command JSON (see `outboundDataHasStatusContext`). */
  data?: unknown;
}

function wireFrameDataRecord(
  data: Record<string, unknown>,
): Record<string, unknown> | null {
  const inner = data.data;
  if (
    inner !== undefined &&
    inner !== null &&
    typeof inner === "object" &&
    !Array.isArray(inner)
  ) {
    return inner as Record<string, unknown>;
  }
  return null;
}

function openpawletStatusJsonChunk(
  innerObj: Record<string, unknown>,
  legacyStringContent: boolean,
): StreamChunk {
  const chunk: StreamChunk = {
    type: "status",
    openpawlet_status_payload: innerObj,
  };
  if (legacyStringContent) {
    chunk.content = JSON.stringify(innerObj);
  }
  return chunk;
}

function optionalToolFrameFields(
  data: Record<string, unknown>,
): Pick<StreamChunk, "tool_calls" | "reasoning_content"> {
  const normalized = normalizeToolCallsArray(data.tool_calls);
  const tool_calls = normalized.length > 0 ? normalized : undefined;
  const rc = data.reasoning_content;
  const reasoning_content = typeof rc === "string" ? rc : undefined;
  const chunk: Pick<StreamChunk, "tool_calls" | "reasoning_content"> = {};
  if (tool_calls) {
    chunk.tool_calls = tool_calls;
  }
  if (reasoning_content !== undefined) {
    chunk.reasoning_content = reasoning_content;
  }
  return chunk;
}

/**
 * Maps OpenPawlet WS frames to StreamChunk.
 * `stream_end` = one streaming segment finished (OpenPawlet `event: stream_end`).
 * `message` = non-final channel text (retries, status); show until `chat_end`.
 * `chat_end` = full assistant turn finished (`chat_done`); optional `text` for final body.
 *
 * Every frame for one user turn carries the same server-issued
 * `reply_group_id` (see `WebSocketChannel._attach_reply_group_id`); we copy
 * it through so the chat UI can group multi-iteration replies into one bubble.
 */
function _withReplyGroupId(
  chunk: StreamChunk | null,
  data: Record<string, unknown>,
): StreamChunk | null {
  if (!chunk) {
    return null;
  }
  const rg = data.reply_group_id;
  if (typeof rg === "string" && rg) {
    chunk.reply_group_id = rg;
  }
  return chunk;
}

function mapNativeFrameToStreamChunk(
  data: Record<string, unknown>,
): StreamChunk | null {
  const ev = data.event;
  if (ev === "ready") {
    return null;
  }
  if (ev === "delta") {
    const text = typeof data.text === "string" ? data.text : "";
    const extra = optionalToolFrameFields(data);
    if (!text && !extra.tool_calls && extra.reasoning_content === undefined) {
      return null;
    }
    const chunk: StreamChunk = { type: "chat_token", content: text, ...extra };
    if (data.stream_id !== undefined) {
      chunk.stream_id = data.stream_id;
    }
    return chunk;
  }
  if (ev === "reasoning") {
    const text = typeof data.text === "string" ? data.text : "";
    if (!text) {
      return null;
    }
    return {
      type: "chat_token",
      content: "",
      reasoning_content: text,
      reasoning_append: true,
    };
  }
  if (ev === "status") {
    const innerObj = wireFrameDataRecord(data);
    return innerObj ? openpawletStatusJsonChunk(innerObj, false) : null;
  }
  if (ev === "message") {
    const text = typeof data.text === "string" ? data.text : "";
    const msgExtras = optionalToolFrameFields(data);
    const innerObj = wireFrameDataRecord(data);

    if (!text.trim()) {
      if (innerObj && outboundDataHasStatusContext(innerObj)) {
        return openpawletStatusJsonChunk(innerObj, true);
      }
      if (msgExtras.reasoning_content !== undefined) {
        return {
          type: "chat_token",
          content: "",
          reasoning_content: msgExtras.reasoning_content,
          reasoning_append: false,
        };
      }
      return null;
    }

    return { type: "channel_notice", content: text, ...msgExtras };
  }
  if (ev === "stream_end") {
    const extra = optionalToolFrameFields(data);
    const chunk: StreamChunk = { type: "stream_end", ...extra };
    if (data.stream_id !== undefined) {
      chunk.stream_id = data.stream_id;
    }
    return chunk;
  }
  if (ev === "chat_start") {
    return { type: "chat_start" };
  }
  if (ev === "chat_end") {
    const extra = optionalToolFrameFields(data);
    const textRaw =
      (typeof data.text === "string" ? data.text : "") ||
      (typeof data.content === "string" ? data.content : "") ||
      (typeof data.message === "string" ? data.message : "");
    return { type: "chat_done", content: textRaw, ...extra };
  }
  if (ev === "tool_event") {
    const mergedTools = mergeToolCallsWithResults(
      normalizeToolCallsArray(data.tool_calls),
      normalizeToolResultItems(data.tool_results),
    );
    const synthetic: Record<string, unknown> = {
      ...data,
      tool_calls: mergedTools,
    };
    const text = typeof data.text === "string" ? data.text : "";
    const extra = optionalToolFrameFields(synthetic);
    if (
      text === "" &&
      !extra.tool_calls?.length &&
      extra.reasoning_content === undefined
    ) {
      return null;
    }
    return { type: "chat_token", content: text, ...extra };
  }
  if (typeof ev === "string" && ev.length > 0) {
    console.warn("[openpawlet-ws] unmapped event (dropped):", ev, data);
  }
  return null;
}

/** Default `/openpawlet-ws` proxies to OpenPawlet built-in `websocket` channel. Empty string disables. */
export function resolveOpenPawletWsBase(): string {
  const raw = import.meta.env.VITE_OPENPAWLET_WS_BASE;
  if (raw === undefined) {
    return "/openpawlet-ws";
  }
  return String(raw).trim();
}

/** Fixed `client_id` for the console WebSocket URL (OpenPawlet native handshake). */
export const OPENPAWLET_WS_URL_CLIENT_ID = "openpawlet-web";

/**
 * Canonical chat `session_key` from `ready.chat_id`: prefix `websocket:` for OpenPawlet routing.
 * Idempotent if `chat_id` already includes the prefix.
 */
export function openpawletSessionKeyFromReadyChatId(chatId: string): string {
  const trimmed = chatId.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("websocket:")) {
    return trimmed;
  }
  return `websocket:${trimmed}`;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isStandardUuidString(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/**
 * Extract a standard UUID for `?chat_id=` resume from a console route key
 * (`websocket:<uuid>` or raw UUID).
 */
export function tryParseOpenPawletResumeChatId(
  sessionKeyOrRoute: string | null | undefined,
): string | null {
  if (sessionKeyOrRoute === undefined || sessionKeyOrRoute === null) {
    return null;
  }
  const raw = String(sessionKeyOrRoute).trim();
  if (!raw) {
    return null;
  }
  if (isStandardUuidString(raw)) {
    return raw.toLowerCase();
  }
  if (raw.startsWith("websocket:")) {
    const inner = raw.slice("websocket:".length).trim();
    return isStandardUuidString(inner) ? inner.toLowerCase() : null;
  }
  return null;
}

export interface OpenPawletWsUrlOptions {
  /** Prior `ready.chat_id` (standard UUID); adds `?chat_id=` for session resume. */
  resumeChatId?: string | null;
  /** Optional; uses `VITE_OPENPAWLET_WS_TOKEN` when set. */
  token?: string | null;
}

/**
 * Build `ws:` / `wss:` URL per OpenPawlet websocket channel docs:
 * `?client_id=&token=&chat_id=`
 */
export function buildOpenPawletChannelWsUrl(
  options?: OpenPawletWsUrlOptions,
): string {
  const trimmed = resolveOpenPawletWsBase();
  if (!trimmed) {
    return "";
  }
  const opts = options ?? {};
  const envToken = (import.meta.env.VITE_OPENPAWLET_WS_TOKEN as string | undefined)?.trim();
  const token =
    opts.token !== undefined && opts.token !== null && String(opts.token).trim()
      ? String(opts.token).trim()
      : envToken || null;
  const resumeRaw =
    opts.resumeChatId !== undefined && opts.resumeChatId !== null
      ? String(opts.resumeChatId).trim()
      : "";
  const params = new URLSearchParams();
  params.set("client_id", OPENPAWLET_WS_URL_CLIENT_ID);
  if (resumeRaw && isStandardUuidString(resumeRaw)) {
    params.set("chat_id", resumeRaw.toLowerCase());
  }
  if (token) {
    params.set("token", token);
  }
  const query = params.toString();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    const base = trimmed.replace(/\/$/, "");
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}${query}`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  const pathNorm = path.replace(/\/$/, "");
  return `${proto}//${window.location.host}${pathNorm}/?${query}`;
}

/**
 * Tear down a WebSocket without triggering Chromium's
 * "WebSocket is closed before the connection is established" when the socket is
 * still CONNECTING (common with React 18 StrictMode double mount).
 */
function disposeOpenPawletWebSocket(ws: WebSocket): void {
  if (ws.readyState === WebSocket.CONNECTING) {
    ws.addEventListener("open", () => ws.close(), { once: true });
    return;
  }
  if (
    ws.readyState === WebSocket.OPEN ||
    ws.readyState === WebSocket.CLOSING
  ) {
    ws.close();
  }
}

export function useOpenPawletChannelWebSocket(options: {
  enabled: boolean;
  /**
   * When the URL is `/chat/:sessionKey`, pass the decoded key so refresh/reconnect
   * keeps the same logical session instead of adopting each `ready.chat_id` as new.
   */
  canonicalSessionKeyFromRoute?: string | null;
  /**
   * Standard UUID parsed from the route (`websocket:<uuid>` or raw UUID); sent as
   * `?chat_id=` on the WebSocket URL so the server resumes the persisted chat.
   */
  resumeChatId?: string | null;
  /**
   * Called once per successful `ready` with `session_busy` from OpenPawlet gateway
   * (agent turn still running for this chat).
   */
  onReadySessionBusy?: (busy: boolean) => void;
}) {
  const {
    enabled,
    canonicalSessionKeyFromRoute = null,
    resumeChatId = null,
    onReadySessionBusy,
  } = options;
  const onReadySessionBusyRef = useRef(onReadySessionBusy);
  onReadySessionBusyRef.current = onReadySessionBusy;
  const [ready, setReady] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const canonicalFromRouteRef = useRef<string | null>(null);
  canonicalFromRouteRef.current =
    typeof canonicalSessionKeyFromRoute === "string" &&
    canonicalSessionKeyFromRoute.trim().length > 0
      ? canonicalSessionKeyFromRoute.trim()
      : null;
  const resumeChatIdRef = useRef<string | null>(null);
  resumeChatIdRef.current =
    typeof resumeChatId === "string" && resumeChatId.trim().length > 0
      ? resumeChatId.trim().toLowerCase()
      : null;
  const setAgentWsReady = useAppStore((s) => s.setAgentWsReady);
  const setOpenPawletChatId = useAppStore((s) => s.setOpenPawletChatId);
  const setOpenPawletClientId = useAppStore((s) => s.setOpenPawletClientId);

  useEffect(() => {
    setAgentWsReady(ready);
  }, [ready, setAgentWsReady]);

  const clearReconnect = () => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  /**
   * useLayoutEffect so route-driven `resumeChatId` / `canonicalSessionKeyFromRoute`
   * updates apply (close old socket, open new) before paint; pairs with
   * `disconnectOpenPawletChannelWebSocket()` for explicit teardown before `flushSync` navigate.
   */
  useLayoutEffect(() => {
    openpawletChannelHardDisconnectRef.current = null;

    const base = resolveOpenPawletWsBase();
    const setAgentWsLinked = useAppStore.getState().setAgentWsLinked;
    if (!enabled || !base) {
      setAgentWsLinked(false);
      setOpenPawletChatId(null);
      setOpenPawletClientId(null);
      clearReconnect();
      setReady(false);
      if (wsRef.current) {
        const w = wsRef.current;
        wsRef.current = null;
        disposeOpenPawletWebSocket(w);
      }
      return;
    }

    const handshakeUrl = buildOpenPawletChannelWsUrl({
      resumeChatId: resumeChatIdRef.current,
    });
    if (!handshakeUrl) {
      setAgentWsLinked(false);
      setOpenPawletChatId(null);
      setOpenPawletClientId(null);
      return;
    }

    setAgentWsLinked(true);
    setOpenPawletChatId(null);
    const routeKeyOnConnect = canonicalFromRouteRef.current;
    if (routeKeyOnConnect) {
      setOpenPawletClientId(routeKeyOnConnect);
    } else {
      setOpenPawletClientId(null);
    }

    let cancelled = false;
    /** 每次 effect 清理或发起新连接时递增；旧 socket 的 onclose 若代数不一致则不重连 */
    let connectGeneration = 0;

    const hardDisconnect = () => {
      cancelled = true;
      connectGeneration += 1;
      clearReconnect();
      isConnectingRef.current = false;
      setReady(false);
      useAppStore.getState().setAgentWsLinked(false);
      useAppStore.getState().setOpenPawletChatId(null);
      useAppStore.getState().setOpenPawletClientId(null);
      if (wsRef.current) {
        const w = wsRef.current;
        wsRef.current = null;
        disposeOpenPawletWebSocket(w);
      }
    };

    openpawletChannelHardDisconnectRef.current = hardDisconnect;

    const connect = () => {
      if (cancelled) {
        return;
      }
      if (isConnectingRef.current) {
        return;
      }
      isConnectingRef.current = true;
      clearReconnect();

      const myGen = ++connectGeneration;

      try {
        const url = buildOpenPawletChannelWsUrl({
          resumeChatId: resumeChatIdRef.current,
        });
        if (!url) {
          isConnectingRef.current = false;
          return;
        }
        const ws = new WebSocket(url);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled || myGen !== connectGeneration) {
            disposeOpenPawletWebSocket(ws);
            return;
          }
          isConnectingRef.current = false;
          // Ready for UI/send only after server `{ event: "ready", chat_id }` (registers route).
          console.log("[openpawlet-ws] socket open, awaiting ready", url);
        };

        ws.onmessage = (event: MessageEvent<string>) => {
          const raw =
            typeof event.data === "string" ? event.data : String(event.data);
          useAppStore.getState().addOpenPawletWsDebugLine(raw);
          try {
            if (myGen !== connectGeneration) {
              return;
            }
            const data = JSON.parse(event.data) as Record<string, unknown>;
            const ev = data.event;
            if (ev === "ready") {
              const rawId = data.chat_id;
              const cid =
                typeof rawId === "string" && rawId.trim().length > 0
                  ? rawId.trim()
                  : null;
              const derivedSessionKey =
                cid !== null ? openpawletSessionKeyFromReadyChatId(cid) : null;
              const routeKey = canonicalFromRouteRef.current;
              const canonicalSessionKey =
                routeKey !== null && routeKey.length > 0
                  ? routeKey
                  : derivedSessionKey;
              const wireClientId = data.client_id;
              const wireClientIdStr =
                typeof wireClientId === "string" && wireClientId.trim().length > 0
                  ? wireClientId.trim()
                  : "";
              const resumedWire = data.resumed === true;
              const sessionBusyWire = data.session_busy === true;
              if (cancelled || myGen !== connectGeneration) {
                return;
              }
              onReadySessionBusyRef.current?.(sessionBusyWire);
              setOpenPawletChatId(cid);
              setOpenPawletClientId(
                canonicalSessionKey !== null && canonicalSessionKey.length > 0
                  ? canonicalSessionKey
                  : null,
              );
              setReady(true);
              console.log(
                "[openpawlet-ws] ready",
                url,
                cid ?? "",
                canonicalSessionKey ?? "",
                wireClientIdStr,
                "resumed=",
                resumedWire,
                "session_busy=",
                sessionBusyWire,
              );
              return;
            }
            const chunk = _withReplyGroupId(
              mapNativeFrameToStreamChunk(data),
              data,
            );
            if (chunk) {
              dispatchChatChunk(chunk, "openpawlet");
            }
          } catch (e) {
            console.error("[openpawlet-ws] parse error", e);
          }
        };

        ws.onclose = (closeEv) => {
          isConnectingRef.current = false;
          if (myGen !== connectGeneration) {
            return;
          }
          const replacedByPeer =
            closeEv.code === 1000 &&
            closeEv.reason === "replaced by new connection";
          setOpenPawletChatId(null);
          const rk = canonicalFromRouteRef.current;
          if (!rk) {
            setOpenPawletClientId(null);
          }
          setReady(false);
          wsRef.current = null;
          if (cancelled) {
            return;
          }
          if (replacedByPeer) {
            useAppStore.getState().addToast({
              type: "warning",
              message: i18n.t("chat.openpawletWsDuplicateTab"),
            });
            return;
          }
          reconnectTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, 3000);
        };

        ws.onerror = () => {
          isConnectingRef.current = false;
        };
      } catch (e) {
        console.error("[openpawlet-ws] create error", e);
        isConnectingRef.current = false;
      }
    };

    connect();

    return () => {
      openpawletChannelHardDisconnectRef.current = null;
      hardDisconnect();
    };
  }, [
    enabled,
    canonicalSessionKeyFromRoute,
    resumeChatId,
    setOpenPawletChatId,
    setOpenPawletClientId,
  ]);

  const sendMessage = useCallback(
    (payload: { content: string; botId: string | null }) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("openpawlet WebSocket not connected");
      }
      const routeSk = canonicalFromRouteRef.current;
      const liveChatId = useAppStore.getState().openpawletChatId;
      const resolvedChatId =
        liveChatId && liveChatId.trim().length > 0
          ? liveChatId.trim()
          : tryParseOpenPawletResumeChatId(routeSk);
      const resolvedSessionKey =
        routeSk && routeSk.length > 0
          ? routeSk
          : resolvedChatId
            ? openpawletSessionKeyFromReadyChatId(resolvedChatId)
            : null;
      /**
       * Always pin the outbound message to the active session so OpenPawlet
       * `WebSocketChannel` persists it under the same `sessions/<key>.jsonl`
       * file across reconnects and route changes. Without these fields the
       * server falls back to the connection's chat_id (or anon-id), which is
       * what caused "new session every message" in the bare /chat flow.
       */
      const body: Record<string, unknown> = {
        content: payload.content,
      };
      if (resolvedChatId) {
        body.chat_id = resolvedChatId;
      }
      if (resolvedSessionKey) {
        body.session_key = resolvedSessionKey;
      }
      const metadata: Record<string, unknown> = { source: "console" };
      if (payload.botId) {
        metadata.bot_id = payload.botId;
      }
      body.metadata = metadata;
      const outbound = JSON.stringify(body);
      useAppStore.getState().addOpenPawletWsDebugLine(`[out] ${outbound}`);
      ws.send(outbound);
    },
    [],
  );

  return { sendMessage, ready, wsRef };
}
