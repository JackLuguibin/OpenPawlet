import { useQuery } from '@tanstack/react-query';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { parseAgentTimeZoneFromConfig } from '../utils/agentDatetime';

/**
 * Resolved IANA timezone from cached ``GET /config`` (same query key as Settings).
 */
export function useAgentTimeZone(): string {
  const currentBotId = useAppStore((s) => s.currentBotId);
  const { data: config } = useQuery({
    queryKey: ['config', currentBotId],
    queryFn: () => api.getConfig(currentBotId),
  });
  return parseAgentTimeZoneFromConfig(config);
}
