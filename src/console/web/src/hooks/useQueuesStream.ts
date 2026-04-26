import { useCallback, useEffect, useRef, useState } from 'react';
import type { QueueSnapshot } from '../api/client';
import { useReconnectingWebSocket } from './useReconnectingWebSocket';

/**
 * Live WebSocket feed for the /queues page.
 *
 * Wire protocol (tick frames from the broker):
 *   { type: "tick", at, metrics, rates, paused, connections, dedupe, samples? }
 *
 * The hook connects same-origin to the FastAPI route registered by
 * ``console.server.queues_router`` (``/queues/stream``); the legacy
 * ``/queues-ws`` alias is also accepted server-side for backward
 * compatibility with older proxies.  Reconnection / backoff logic is
 * delegated to ``useReconnectingWebSocket`` so the same battle-tested
 * lifecycle code is shared with the console-push hook.  The caller can
 * still ``subscribe(['samples'])`` to opt into sample pushes (off by
 * default to keep the tick payload small).
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

function resolveWsUrl(): string | null {
  if (typeof window === 'undefined') return null;
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/queues/stream`;
}

export function useQueuesStream(enabled: boolean = true): UseQueuesStreamResult {
  const [tick, setTick] = useState<QueueTick | null>(null);
  const desiredSubsRef = useRef<Set<string>>(new Set());

  const handleMessage = useCallback((data: string) => {
    try {
      const parsed = JSON.parse(data);
      if (parsed && parsed.type === 'tick') {
        setTick(parsed as QueueTick);
      }
    } catch {
      /* ignore non-JSON frames */
    }
  }, []);

  const handleOpen = useCallback((ws: WebSocket) => {
    const topics = Array.from(desiredSubsRef.current);
    if (topics.length > 0) {
      try {
        ws.send(JSON.stringify({ op: 'subscribe', topics }));
      } catch {
        /* ignore */
      }
    }
  }, []);

  const url = resolveWsUrl();
  const { connected, error, send, reconnect } = useReconnectingWebSocket(url, enabled, {
    onOpen: handleOpen,
    onMessage: handleMessage,
  });

  const subscribe = useCallback(
    (topics: string[]) => {
      topics.forEach((t) => desiredSubsRef.current.add(t));
      send(JSON.stringify({ op: 'subscribe', topics }));
    },
    [send],
  );

  const unsubscribe = useCallback(
    (topics: string[]) => {
      topics.forEach((t) => desiredSubsRef.current.delete(t));
      send(JSON.stringify({ op: 'unsubscribe', topics }));
    },
    [send],
  );

  // Keep the disable path explicit so consumers see tick reset when
  // they flip the feature off (legacy hook also reset connected; we
  // mirror the behaviour).
  useEffect(() => {
    if (!enabled) {
      setTick(null);
    }
  }, [enabled]);

  return { tick, connected, error, subscribe, unsubscribe, reconnect };
}
