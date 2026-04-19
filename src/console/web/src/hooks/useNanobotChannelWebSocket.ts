import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import type { StreamChunk } from "../api/types";
import { useAppStore } from "../store";
import i18n from "../i18n";
import {
  mergeToolCallsWithResults,
  normalizeToolCallsArray,
  normalizeToolResultItems,
} from "../utils/toolCalls";

import { dispatchChatChunk } from "./useWebSocket";

/**
 * Latest nanobot socket teardown from `useNanobotChannelWebSocket` (e.g. delete flow:
 * disconnect → navigate → DELETE).
 */
const nanobotChannelHardDisconnectRef: { current: (() => void) | null } = {
  current: null,
};

/**
 * Synchronously close the nanobot channel WebSocket, cancel reconnect, and clear
 * link state. Call **before** changing the chat route when the old session must
 * not receive another `ready` (e.g. deleting the current session).
 */
export function disconnectNanobotChannelWebSocket(): void {
  nanobotChannelHardDisconnectRef.current?.();
}

/** Frames from `nanobot.channels.websocket` (WebSocketChannel). */
export interface NanobotNativeWsFrame {
  event:
    | "ready"
    | "message"
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
  /** True when the client resumed via `?chat_id=` (see nanobot WS docs). */
  resumed?: boolean;
  media?: string[];
  reply_to?: string;
  stream_id?: unknown;
  tool_calls?: unknown;
  reasoning_content?: string;
  /** OutboundMessage.data — may carry status/command JSON (see `outboundDataHasStatusContext`). */
  data?: unknown;
}

/**
 * Same shape checks as Chat `extractNanobotStatusContext` — outbound `message.data`
 * may use `context` or nested `data.context`.
 */
function outboundDataHasStatusContext(root: Record<string, unknown>): boolean {
  const direct = root.context;
  if (direct !== undefined && typeof direct === "object" && direct !== null) {
    return true;
  }
  const wrapped = root.data;
  if (
    wrapped !== undefined &&
    typeof wrapped === "object" &&
    wrapped !== null &&
    !Array.isArray(wrapped)
  ) {
    const nested = (wrapped as Record<string, unknown>).context;
    if (nested !== undefined && typeof nested === "object" && nested !== null) {
      return true;
    }
  }
  return false;
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
 * Maps nanobot WS frames to StreamChunk.
 * `stream_end` = one streaming segment/frame finished (`stream_frame_end`).
 * `message` = non-final channel text (retries, status); show until `chat_end`.
 * `chat_end` = full assistant turn finished (`chat_done`); optional `text` for final body.
 */
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
  if (ev === "message") {
    const text = typeof data.text === "string" ? data.text : "";
    const msgExtras = optionalToolFrameFields(data);
    const inner = data.data;
    const innerObj =
      inner !== undefined &&
      inner !== null &&
      typeof inner === "object" &&
      !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : null;

    if (!text.trim()) {
      if (innerObj && outboundDataHasStatusContext(innerObj)) {
        return {
          type: "nanobot_status_json",
          content: JSON.stringify(innerObj),
        };
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
    const chunk: StreamChunk = { type: "stream_frame_end", ...extra };
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
    console.warn("[nanobot-ws] unmapped event (dropped):", ev, data);
  }
  return null;
}

/** Default `/nanobot-ws` proxies to nanobot built-in `websocket` channel. Empty string disables. */
export function resolveNanobotWsBase(): string {
  const raw = import.meta.env.VITE_NANOBOT_WS_BASE;
  if (raw === undefined) {
    return "/nanobot-ws";
  }
  return String(raw).trim();
}

/** Fixed `client_id` for the console WebSocket URL (nanobot native handshake). */
export const NANOBOT_WS_URL_CLIENT_ID = "nanobot-web";

/**
 * Canonical chat `session_key` from `ready.chat_id`: prefix `websocket:` for nanobot routing.
 * Idempotent if `chat_id` already includes the prefix.
 */
export function nanobotSessionKeyFromReadyChatId(chatId: string): string {
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
export function tryParseNanobotResumeChatId(
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

export interface NanobotWsUrlOptions {
  /** Prior `ready.chat_id` (standard UUID); adds `?chat_id=` for session resume. */
  resumeChatId?: string | null;
  /** Optional; defaults to `import.meta.env.VITE_NANOBOT_WS_TOKEN`. */
  token?: string | null;
}

/**
 * Build `ws:` / `wss:` URL per nanobot docs:
 * `?client_id=&token=&chat_id=`
 */
export function buildNanobotChannelWsUrl(
  options?: NanobotWsUrlOptions,
): string {
  const trimmed = resolveNanobotWsBase();
  if (!trimmed) {
    return "";
  }
  const opts = options ?? {};
  const envToken = (
    import.meta.env.VITE_NANOBOT_WS_TOKEN as string | undefined
  )?.trim();
  const token =
    opts.token !== undefined && opts.token !== null && String(opts.token).trim()
      ? String(opts.token).trim()
      : envToken || null;
  const resumeRaw =
    opts.resumeChatId !== undefined && opts.resumeChatId !== null
      ? String(opts.resumeChatId).trim()
      : "";
  const params = new URLSearchParams();
  params.set("client_id", NANOBOT_WS_URL_CLIENT_ID);
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

export function useNanobotChannelWebSocket(options: {
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
}) {
  const {
    enabled,
    canonicalSessionKeyFromRoute = null,
    resumeChatId = null,
  } = options;
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
  const setNanobotChatId = useAppStore((s) => s.setNanobotChatId);
  const setNanobotClientId = useAppStore((s) => s.setNanobotClientId);

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
   * `disconnectNanobotChannelWebSocket()` for explicit teardown before `flushSync` navigate.
   */
  useLayoutEffect(() => {
    nanobotChannelHardDisconnectRef.current = null;

    const base = resolveNanobotWsBase();
    const setAgentWsLinked = useAppStore.getState().setAgentWsLinked;
    if (!enabled || !base) {
      setAgentWsLinked(false);
      setNanobotChatId(null);
      setNanobotClientId(null);
      clearReconnect();
      setReady(false);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      return;
    }

    const handshakeUrl = buildNanobotChannelWsUrl({
      resumeChatId: resumeChatIdRef.current,
    });
    if (!handshakeUrl) {
      setAgentWsLinked(false);
      setNanobotChatId(null);
      setNanobotClientId(null);
      return;
    }

    setAgentWsLinked(true);
    setNanobotChatId(null);
    const routeKeyOnConnect = canonicalFromRouteRef.current;
    if (routeKeyOnConnect) {
      setNanobotClientId(routeKeyOnConnect);
    } else {
      setNanobotClientId(null);
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
      useAppStore.getState().setNanobotChatId(null);
      useAppStore.getState().setNanobotClientId(null);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };

    nanobotChannelHardDisconnectRef.current = hardDisconnect;

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
        const url = buildNanobotChannelWsUrl({
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
            return;
          }
          isConnectingRef.current = false;
          // Ready for UI/send only after server `{ event: "ready", chat_id }` (registers route).
          console.log("[nanobot-ws] socket open, awaiting ready", url);
        };

        ws.onmessage = (event: MessageEvent<string>) => {
          const raw =
            typeof event.data === "string" ? event.data : String(event.data);
          useAppStore.getState().addNanobotWsDebugLine(raw);
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
                cid !== null ? nanobotSessionKeyFromReadyChatId(cid) : null;
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
              if (cancelled || myGen !== connectGeneration) {
                return;
              }
              setNanobotChatId(cid);
              setNanobotClientId(
                canonicalSessionKey !== null && canonicalSessionKey.length > 0
                  ? canonicalSessionKey
                  : null,
              );
              setReady(true);
              console.log(
                "[nanobot-ws] ready",
                url,
                cid ?? "",
                canonicalSessionKey ?? "",
                wireClientIdStr,
                "resumed=",
                resumedWire,
              );
              return;
            }
            const chunk = mapNativeFrameToStreamChunk(data);
            if (chunk) {
              dispatchChatChunk(chunk);
            }
          } catch (e) {
            console.error("[nanobot-ws] parse error", e);
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
          setNanobotChatId(null);
          const rk = canonicalFromRouteRef.current;
          if (!rk) {
            setNanobotClientId(null);
          }
          setReady(false);
          wsRef.current = null;
          if (cancelled) {
            return;
          }
          if (replacedByPeer) {
            useAppStore.getState().addToast({
              type: "warning",
              message: i18n.t("chat.nanobotWsDuplicateTab"),
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
        console.error("[nanobot-ws] create error", e);
        isConnectingRef.current = false;
      }
    };

    connect();

    return () => {
      nanobotChannelHardDisconnectRef.current = null;
      hardDisconnect();
    };
  }, [
    enabled,
    canonicalSessionKeyFromRoute,
    resumeChatId,
    setNanobotChatId,
    setNanobotClientId,
  ]);

  const sendMessage = useCallback(
    (payload: { content: string; botId: string | null }) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        throw new Error("nanobot WebSocket not connected");
      }
      const body: Record<string, unknown> = {
        content: payload.content,
      };
      if (payload.botId) {
        body.metadata = {
          bot_id: payload.botId,
          source: "console",
        };
      }
      const outbound = JSON.stringify(body);
      useAppStore.getState().addNanobotWsDebugLine(`[out] ${outbound}`);
      ws.send(outbound);
    },
    [],
  );

  return { sendMessage, ready, wsRef };
}
