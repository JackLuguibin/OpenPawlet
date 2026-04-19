import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import type { BotInfo } from '../api/types';

const BOTS_STALE_MS = 60_000;

/** Bot list for the current console; shared query key with invalidations in `useWebSocket`. */
export function useBots() {
  return useQuery<BotInfo[]>({
    queryKey: ['bots'],
    queryFn: api.listBots,
    staleTime: BOTS_STALE_MS,
  });
}
