import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shared reconnecting WebSocket hook used by the Queues stream and the
 * console-push hook.  Both call sites had near-identical lifecycle code
 * (connect, exponential backoff, message parsing, manual reconnect);
 * sharing it removes drift between the two clients.
 *
 * The hook intentionally exposes raw lifecycle events instead of a
 * curated payload type so callers can layer their own typed parsers on
 * top.  It does not attempt to handle WebSocket sub-protocols, JSON vs
 * binary, or auth tokens - those concerns are application-specific.
 */

export interface ReconnectingWebSocketOptions {
  /** Called once after every successful open. */
  onOpen?: (ws: WebSocket) => void;
  /** Called for every text frame.  Binary frames are ignored. */
  onMessage?: (data: string, ws: WebSocket) => void;
  /** Called when the underlying socket reports an error. */
  onError?: (event: Event, ws: WebSocket | null) => void;
  /** Called after every close (regardless of whether we will reconnect). */
  onClose?: (event: CloseEvent | null) => void;
  /** Initial backoff in ms; doubled per attempt up to ``maxBackoffMs``. */
  baseBackoffMs?: number;
  /** Hard ceiling on backoff between retries. */
  maxBackoffMs?: number;
}

export interface ReconnectingWebSocketHandle {
  connected: boolean;
  error: string | null;
  send: (data: string | ArrayBuffer | Blob) => boolean;
  reconnect: () => void;
}

const DEFAULT_BASE_BACKOFF = 1000;
const DEFAULT_MAX_BACKOFF = 30_000;

export function useReconnectingWebSocket(
  url: string | null,
  enabled: boolean,
  opts: ReconnectingWebSocketOptions = {},
): ReconnectingWebSocketHandle {
  const {
    onOpen,
    onMessage,
    onError,
    onClose,
    baseBackoffMs = DEFAULT_BASE_BACKOFF,
    maxBackoffMs = DEFAULT_MAX_BACKOFF,
  } = opts;

  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);

  // Keep the latest callbacks in refs so the connect() closure does not
  // need them as dependencies (callers often pass inline functions).
  const handlersRef = useRef({ onOpen, onMessage, onError, onClose });
  handlersRef.current = { onOpen, onMessage, onError, onClose };

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!enabled || !url) return;
    clearTimer();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      scheduleReconnect();
      return;
    }
    wsRef.current = ws;
    ws.onopen = () => {
      retryRef.current = 0;
      setConnected(true);
      setError(null);
      handlersRef.current.onOpen?.(ws);
    };
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      handlersRef.current.onMessage?.(event.data, ws);
    };
    ws.onerror = (event) => {
      setError('websocket error');
      handlersRef.current.onError?.(event, ws);
    };
    ws.onclose = (event) => {
      setConnected(false);
      wsRef.current = null;
      handlersRef.current.onClose?.(event);
      if (shouldReconnectRef.current) {
        scheduleReconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, url]);

  const scheduleReconnect = useCallback(() => {
    clearTimer();
    retryRef.current = Math.min(retryRef.current + 1, 6);
    const delay = Math.min(maxBackoffMs, baseBackoffMs * 2 ** retryRef.current);
    timerRef.current = window.setTimeout(() => {
      connect();
    }, delay);
  }, [baseBackoffMs, connect, maxBackoffMs]);

  const reconnect = useCallback(() => {
    const ws = wsRef.current;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
    retryRef.current = 0;
    connect();
  }, [connect]);

  const send = useCallback(
    (data: string | ArrayBuffer | Blob): boolean => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      try {
        ws.send(data);
        return true;
      } catch {
        return false;
      }
    },
    [],
  );

  useEffect(() => {
    shouldReconnectRef.current = enabled;
    if (enabled && url) {
      connect();
    } else {
      clearTimer();
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
      setConnected(false);
    }
    return () => {
      shouldReconnectRef.current = false;
      clearTimer();
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, [enabled, url, connect]);

  return { connected, error, send, reconnect };
}
