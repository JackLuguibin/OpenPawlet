import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueSnapshot } from '../api/client';

/**
 * Live WebSocket feed for the /queues page.
 *
 * Wire protocol (tick frames from the broker):
 *   { type: "tick", at, metrics, rates, paused, connections, dedupe, samples? }
 *
 * The hook connects same-origin to the FastAPI route registered by
 * ``console.server.queues_router`` (``/queues/stream``); the legacy
 * ``/queues-ws`` alias is also accepted server-side for backward
 * compatibility with older proxies.  On transient failures the hook
 * reconnects with exponential backoff (up to 30s).  The caller can call
 * ``subscribe(['samples'])`` to opt into sample pushes (off by default to
 * keep the tick payload small).
 */
export interface QueueTick {
  type: 'tick';
  at: number;
  metrics: Record<string, number>;
  rates: Record<string, number>;
  paused: { inbound: boolean; outbound: boolean };
  connections: QueueSnapshot['connections'];
  dedupe: QueueSnapshot['dedupe'];
  samples?: QueueSnapshot['samples'];
}

export interface UseQueuesStreamResult {
  tick: QueueTick | null;
  connected: boolean;
  error: string | null;
  subscribe: (topics: string[]) => void;
  unsubscribe: (topics: string[]) => void;
  reconnect: () => void;
}

function resolveWsUrl(): string {
  if (typeof window === 'undefined') return '';
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/queues/stream`;
}

export function useQueuesStream(enabled: boolean = true): UseQueuesStreamResult {
  const [tick, setTick] = useState<QueueTick | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef<number>(0);
  const timerRef = useRef<number | null>(null);
  const desiredSubsRef = useRef<Set<string>>(new Set());
  const shouldReconnectRef = useRef(true);

  const clearTimer = () => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const connect = useCallback(() => {
    if (!enabled) return;
    clearTimer();
    const url = resolveWsUrl();
    if (!url) return;
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
      const topics = Array.from(desiredSubsRef.current);
      if (topics.length > 0) {
        try {
          ws.send(JSON.stringify({ op: 'subscribe', topics }));
        } catch {
          /* ignore - the onerror path will handle it */
        }
      }
    };
    ws.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && parsed.type === 'tick') {
          setTick(parsed as QueueTick);
        }
      } catch {
        // Non-JSON frames are ignored; the broker never sends them today.
      }
    };
    ws.onerror = () => {
      setError('queues websocket error');
    };
    ws.onclose = () => {
      setConnected(false);
      wsRef.current = null;
      if (shouldReconnectRef.current) {
        scheduleReconnect();
      }
    };
  }, [enabled]);

  const scheduleReconnect = useCallback(() => {
    clearTimer();
    retryRef.current = Math.min(retryRef.current + 1, 6);
    const delay = Math.min(30_000, 1000 * 2 ** retryRef.current);
    timerRef.current = window.setTimeout(() => {
      connect();
    }, delay);
  }, [connect]);

  const subscribe = useCallback((topics: string[]) => {
    topics.forEach((t) => desiredSubsRef.current.add(t));
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ op: 'subscribe', topics }));
      } catch {
        /* ignore - next reconnect will resend */
      }
    }
  }, []);

  const unsubscribe = useCallback((topics: string[]) => {
    topics.forEach((t) => desiredSubsRef.current.delete(t));
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ op: 'unsubscribe', topics }));
      } catch {
        /* ignore */
      }
    }
  }, []);

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

  useEffect(() => {
    shouldReconnectRef.current = enabled;
    if (enabled) {
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
  }, [enabled, connect]);

  return { tick, connected, error, subscribe, unsubscribe, reconnect };
}
