import { useEffect, useRef, useCallback } from 'react';
import type { RefObject } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAppStore } from '../store';
import type {
  StatusResponse,
  SessionInfo,
  WSMessage,
  ActivityItem,
  ChannelStatus,
  MCPStatus,
  Message,
} from '../api/types';
import type { StreamChunk } from '../api/types';

/**
 * Origin of a chat stream chunk. `console` is the FastAPI `/ws/state` push,
 * `openpawlet` is the built-in OpenPawlet `/openpawlet-ws` channel. Handlers can use
 * this tag to dedupe when both transports are active (see Chat.tsx).
 */
export type ChatChunkSource = "console" | "openpawlet";

// Global chat message handler registry (used by Chat.tsx for WS streaming)
type ChatMessageHandler = (chunk: StreamChunk, source: ChatChunkSource) => void;
const _chatHandlers = new Set<ChatMessageHandler>();

export function registerChatHandler(handler: ChatMessageHandler): () => void {
  _chatHandlers.add(handler);
  return () => _chatHandlers.delete(handler);
}

function _dispatchChat(chunk: StreamChunk, source: ChatChunkSource) {
  for (const h of _chatHandlers) {
    try { h(chunk, source); } catch { /* handler errors must not break the WS loop */ }
  }
}

/** Dispatch a chat stream chunk (e.g. from OpenPawlet `ws` channel WebSocket). */
export function dispatchChatChunk(
  chunk: StreamChunk,
  source: ChatChunkSource = "openpawlet",
) {
  _dispatchChat(chunk, source);
}

// Expose wsRef so callers can send messages directly
let _wsRef: RefObject<WebSocket | null> | null = null;
export function getWSRef(): RefObject<WebSocket | null> | null {
  return _wsRef;
}

/**
 * Resolve the URL of the console state-push channel.
 *
 * Resolution order:
 *   1. ``VITE_CONSOLE_WS_URL`` (legacy override; absolute URL or path)
 *   2. Same-origin ``/ws/state`` (the new default; requires the FastAPI
 *      app to mount the route, which it does in `app.py`).
 *
 * Returning a path-only URL (``/ws/state``) makes the browser combine
 * it with the current origin, which works under Vite's dev proxy
 * (``server.proxy['/ws']``) as well as in the bundled SPA served by
 * FastAPI itself.
 */
function resolveConsoleWsUrl(): string {
  const raw = import.meta.env.VITE_CONSOLE_WS_URL;
  if (raw !== undefined && raw !== null) {
    const trimmed = String(raw).trim();
    if (trimmed.length > 0) return trimmed;
  }
  if (typeof window === 'undefined') return '/ws/state';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/state`;
}

/**
 * Append the active ``bot_id`` to the WS URL as a query parameter so the
 * server can hydrate the connection with initial snapshots immediately
 * (saves one round-trip vs. the explicit ``subscribe`` frame after open).
 */
function withBotIdQuery(url: string, botId: string | null): string {
  if (!botId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}bot_id=${encodeURIComponent(botId)}`;
}

/** Whether console real-time push is configured.  Always true now that we
 *  default to same-origin ``/ws/state``.  Kept for backward-compat with
 *  callers that only want to surface a "live" badge in the UI. */
export function isConsoleWebSocketConfigured(): boolean {
  return true;
}

// Reconnect backoff parameters.  We start at 1s, double up to 15s — long
// enough to survive a brief server restart without hammering, short
// enough that a desktop coming out of sleep recovers quickly.
const _BASE_BACKOFF_MS = 1000;
const _MAX_BACKOFF_MS = 15_000;
// Hard idle timeout: if no frame (server ping included) arrives within
// this window, we close and reconnect.  Server pings every 25s so 60s
// is comfortably above the steady-state ceiling.
const _IDLE_TIMEOUT_MS = 60_000;

export function useWebSocket() {
  const queryClient = useQueryClient();
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const idleWatchdogRef = useRef<number | null>(null);
  const isConnectingRef = useRef(false);
  const initialStatusReceivedRef = useRef(false);
  const retryCountRef = useRef(0);
  const lastBotIdRef = useRef<string | null>(null);
  const {
    setWSConnected,
    setWSConnecting,
    setStatus,
    setSessions,
    setChannels,
    setMCPServers,
    addWSMessage,
  } = useAppStore();

  const armIdleWatchdog = useCallback(() => {
    if (idleWatchdogRef.current !== null) {
      window.clearTimeout(idleWatchdogRef.current);
    }
    idleWatchdogRef.current = window.setTimeout(() => {
      // Force-close so the onclose handler triggers reconnect.  Closing
      // is preferable to abandoning the socket because a half-open
      // connection will silently swallow newer frames.
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
    }, _IDLE_TIMEOUT_MS);
  }, []);

  // Forward reference to ``scheduleReconnect`` so ``connect`` can call
  // it without participating in the useCallback dependency cycle (each
  // depends on the other).  Populated below.
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const connect = useCallback(() => {
    if (isConnectingRef.current || (wsRef.current?.readyState === WebSocket.OPEN)) {
      return;
    }

    const baseUrl = resolveConsoleWsUrl();
    const botId = useAppStore.getState().currentBotId;
    lastBotIdRef.current = botId;
    const wsUrl = withBotIdQuery(baseUrl, botId);

    isConnectingRef.current = true;
    setWSConnecting(true);

    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      console.error('[ws/state] creation error:', e);
      isConnectingRef.current = false;
      setWSConnecting(false);
      scheduleReconnectRef.current();
      return;
    }
    wsRef.current = ws;
    _wsRef = wsRef;

    ws.onopen = () => {
      retryCountRef.current = 0;
      isConnectingRef.current = false;
      setWSConnecting(false);
      setWSConnected(true);
      const currentBot = useAppStore.getState().currentBotId;
      // Always send an explicit subscribe so the server can re-target
      // mid-connection bot switches by re-sending the same frame
      // without dropping the socket.
      try {
        ws.send(JSON.stringify({ type: 'subscribe', bot_id: currentBot }));
      } catch {
        /* ignore */
      }
      armIdleWatchdog();
    };

    ws.onmessage = (event) => {
      armIdleWatchdog();
      try {
        const message: WSMessage = JSON.parse(event.data);
        addWSMessage(message);

        const activeBotId = useAppStore.getState().currentBotId;

        // Welcome / keepalive frames carry no UI state of their own.
        if (message.type === 'welcome' || message.type === 'ping' || message.type === 'pong') {
          return;
        }

        // Dispatch chat streaming messages to registered handlers.
        const chatTypes: WSMessage['type'][] = [
          'chat_token', 'chat_done', 'chat_start', 'stream_frame_end',
          'session_key', 'tool_call',
          'tool_result', 'tool_progress', 'channel_notice', 'subagent_start',
          'subagent_done', 'assistant_message', 'error',
          'openpawlet_status_json',
        ];
        if (chatTypes.includes(message.type)) {
          _dispatchChat(message as StreamChunk, "console");
        }

        if (message.type === 'status_update' && message.data) {
          const statusData = message.data as StatusResponse & { bot_id?: string };
          const targetBotId = statusData.bot_id ?? activeBotId;
          queryClient.setQueryData(['status', targetBotId], statusData);
          // Initial connect already gets a fresh ``usage-history`` from
          // its own ``useQuery``; only invalidate after subsequent
          // status pushes (bot just finished a turn etc.) to avoid
          // doubling up the very first fetch.
          if (initialStatusReceivedRef.current) {
            queryClient.invalidateQueries({ queryKey: ['usage-history', targetBotId] });
          } else {
            initialStatusReceivedRef.current = true;
          }
          if (!statusData.bot_id || statusData.bot_id === activeBotId) {
            setStatus(statusData);
            if (statusData.channels) setChannels(statusData.channels);
            if (statusData.mcp_servers) setMCPServers(statusData.mcp_servers);
          }
        }
        if (message.type === 'sessions_update' && message.data) {
          const { sessions, bot_id } = message.data as { sessions: SessionInfo[]; bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          queryClient.setQueryData(['sessions', targetBotId], sessions);
          queryClient.setQueryData(['sessions', 'recent', targetBotId], sessions?.slice(0, 5));
          if (!targetBotId || targetBotId === activeBotId) {
            setSessions(sessions);
          }
        }
        if (message.type === 'session_deleted' && message.data) {
          const { session_key, bot_id } = message.data as { session_key: string; bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          // Drop cached transcripts for the deleted session so any
          // background tab does not flash stale messages on tab focus.
          queryClient.removeQueries({ queryKey: ['session', session_key, targetBotId] });
          queryClient.removeQueries({ queryKey: ['transcript', session_key, targetBotId] });
        }
        if (message.type === 'session_message_appended' && message.data) {
          const { session_key, bot_id } = message.data as {
            session_key: string;
            bot_id?: string;
            message: Message;
          };
          const targetBotId = bot_id ?? activeBotId;
          // Append to any cached transcript so the Chat page renders
          // tool progress without an HTTP refetch. Multiple cache keys
          // exist (full transcript, paginated window) so we touch only
          // the active session's primary key here; Chat's own reducer
          // takes care of the in-flight stream.
          queryClient.invalidateQueries({
            queryKey: ['transcript', session_key, targetBotId],
            exact: false,
          });
        }
        if (message.type === 'channels_update' && message.data) {
          const { channels, bot_id } = message.data as { channels: ChannelStatus[]; bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          queryClient.setQueryData(['channels', targetBotId], channels);
          if (!bot_id || bot_id === activeBotId) {
            setChannels(channels);
          }
        }
        if (message.type === 'mcp_update' && message.data) {
          const { mcp_servers, bot_id } = message.data as { mcp_servers: MCPStatus[]; bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          queryClient.setQueryData(['mcp', targetBotId], mcp_servers);
          if (!bot_id || bot_id === activeBotId) {
            setMCPServers(mcp_servers);
          }
        }
        if (message.type === 'agents_update' && message.data) {
          const { bot_id } = message.data as { bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          // Send a hint; React Query will refetch only if the query is
          // currently mounted, so background tabs do not pay the cost.
          queryClient.invalidateQueries({ queryKey: ['agents', targetBotId] });
          queryClient.invalidateQueries({ queryKey: ['agent-categories', targetBotId] });
          queryClient.invalidateQueries({ queryKey: ['agent-category-overrides', targetBotId] });
        }
        if (message.type === 'runtime_agents_update' && message.data) {
          const { agents, bot_id } = message.data as {
            agents: unknown[];
            bot_id?: string;
          };
          const targetBotId = bot_id ?? activeBotId;
          queryClient.setQueryData(['runtime-agents', targetBotId], agents);
          queryClient.setQueryData(['runtime-agents'], agents);
        }
        if (message.type === 'observability_event' && message.data) {
          const { entry, bot_id } = message.data as { entry: unknown; bot_id?: string };
          const targetBotId = bot_id ?? activeBotId;
          // Push a hint; the timeline page paginates on demand so a
          // refetch is the simplest path that keeps both head and
          // tail consistent.
          queryClient.invalidateQueries({ queryKey: ['observability-timeline', targetBotId], exact: false });
          // Forward the entry through addWSMessage already handled above.
          void entry;
        }
        if (message.type === 'bots_update') {
          queryClient.invalidateQueries({ queryKey: ['bots'] });
        }
        if (message.type === 'activity_update' && message.entry) {
          const entry = message.entry as ActivityItem;
          const queries = queryClient.getQueriesData<ActivityItem[]>({
            queryKey: ['activity'],
            type: 'active',
          });
          for (const [queryKey, old] of queries) {
            if (!old) continue;
            if (old.some((e) => e.id === entry.id)) continue;
            queryClient.setQueryData<ActivityItem[]>(queryKey, [entry, ...old]);
          }
        }
      } catch (e) {
        console.error('[ws/state] parse error:', e);
      }
    };

    ws.onclose = () => {
      isConnectingRef.current = false;
      setWSConnecting(false);
      setWSConnected(false);
      wsRef.current = null;
      initialStatusReceivedRef.current = false;
      if (idleWatchdogRef.current !== null) {
        window.clearTimeout(idleWatchdogRef.current);
        idleWatchdogRef.current = null;
      }
      scheduleReconnectRef.current();
    };

    ws.onerror = () => {
      isConnectingRef.current = false;
      setWSConnecting(false);
    };
  }, [
    queryClient,
    setWSConnected,
    setWSConnecting,
    setStatus,
    setSessions,
    setChannels,
    setMCPServers,
    addWSMessage,
    armIdleWatchdog,
  ]);

  const scheduleReconnect = useCallback(() => {
    if (reconnectTimeoutRef.current !== null) {
      window.clearTimeout(reconnectTimeoutRef.current);
    }
    retryCountRef.current = Math.min(retryCountRef.current + 1, 6);
    const delay = Math.min(
      _MAX_BACKOFF_MS,
      _BASE_BACKOFF_MS * 2 ** (retryCountRef.current - 1),
    );
    reconnectTimeoutRef.current = window.setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  // Keep the ref in sync with the latest closure so the WS callbacks
  // (which were captured before this hook resolved) always invoke the
  // current scheduler.
  scheduleReconnectRef.current = scheduleReconnect;

  // React to bot switches: send a fresh ``subscribe`` frame instead of
  // tearing the socket down (avoids the reconnect dance and the
  // intermittent half-open state).
  const currentBotId = useAppStore((s) => s.currentBotId);
  useEffect(() => {
    if (currentBotId === lastBotIdRef.current) return;
    lastBotIdRef.current = currentBotId;
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'subscribe', bot_id: currentBotId }));
      } catch {
        /* ignore */
      }
    }
  }, [currentBotId]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
      }
      if (idleWatchdogRef.current !== null) {
        window.clearTimeout(idleWatchdogRef.current);
      }
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, [connect]);

  return wsRef;
}
