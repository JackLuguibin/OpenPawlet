import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card, Segmented } from 'antd';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';
import { formatQueryError, isNotFoundError } from '../utils/errors';

type MemorySubTab = 'long_term' | 'history';

function parseHistoryEntries(historyText: string): { timestamp?: string; content: string }[] {
  if (!historyText.trim()) return [];
  const blocks = historyText.split(/\n\n+/).filter((b) => b.trim());
  return blocks.map((block) => {
    const match = block.match(/^\[(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\]\s*(.*)/s);
    if (match) {
      return { timestamp: match[1], content: match[2].trim() };
    }
    return { content: block.trim() };
  });
}

function historyEntryKey(entry: { timestamp?: string; content: string }, index: number): string {
  const head = entry.content.slice(0, 48);
  const h = (s: string) => {
    let h0 = 0;
    for (let i = 0; i < s.length; i++) {
      h0 = (h0 * 31 + s.charCodeAt(i)) | 0;
    }
    return h0;
  };
  return `${entry.timestamp ?? 'na'}-${h(head)}-${index}`;
}

/**
 * Memory panel (long-term memory + history sub-tabs).
 * Renders inner content only; the parent (Knowledge hub) supplies the page chrome.
 */
export function MemoryPanel({ currentBotId }: { currentBotId: string | null }) {
  const { t } = useTranslation();

  const memorySubTabs = useMemo(
    () => [
      { value: 'long_term' as const, label: t('memory.tabLong') },
      { value: 'history' as const, label: t('memory.tabHistory') },
    ],
    [t],
  );
  const [activeMemoryTab, setActiveMemoryTab] = useState<MemorySubTab>('long_term');

  const { data: memory, isLoading, error } = useQuery({
    queryKey: ['memory', currentBotId],
    queryFn: () => api.getMemory(currentBotId),
    enabled: Boolean(currentBotId),
  });

  const historyEntries = useMemo(
    () => (memory?.history ? parseHistoryEntries(memory.history) : []),
    [memory?.history],
  );
  const longTermContent = memory?.long_term?.trim() ?? '';
  const errorDescription = error
    ? isNotFoundError(error)
      ? t('memory.workspaceNotFound')
      : formatQueryError(error)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      <Segmented
        size="small"
        options={memorySubTabs}
        value={activeMemoryTab}
        onChange={(val) => setActiveMemoryTab(val as MemorySubTab)}
      />

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-12">
          <Spin />
        </div>
      ) : error ? (
        <Empty description={<span className="text-red-500">{errorDescription}</span>} />
      ) : activeMemoryTab === 'long_term' ? (
        <Card
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {longTermContent ? (
            <div className="max-w-3xl">
              <div className={MARKDOWN_PROSE_CLASS}>
                <Markdown>{longTermContent}</Markdown>
              </div>
            </div>
          ) : (
            <div className="flex min-h-[200px] flex-1 items-center justify-center">
              <Empty description={t('memory.emptyLong')} />
            </div>
          )}
        </Card>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          {historyEntries.length > 0 ? (
            historyEntries.map((entry, idx) => (
              <Card key={historyEntryKey(entry, idx)} size="small">
                <div className="flex gap-4">
                  {entry.timestamp ? (
                    <span className="shrink-0 pt-0.5 font-mono text-xs text-blue-600 dark:text-blue-400">
                      {entry.timestamp}
                    </span>
                  ) : null}
                  <div className="flex-1 whitespace-pre-wrap text-sm leading-relaxed">
                    {entry.content}
                  </div>
                </div>
              </Card>
            ))
          ) : (
            <div className="flex min-h-[200px] flex-1 items-center justify-center py-12">
              <Empty description={t('memory.emptyHistory')} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Standalone Memory page (legacy route; redirects in the router send users
 * to the Knowledge hub instead).
 */
export default function Memory({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

  if (botsLoading || waitingBot) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (botsFetched && bots.length === 0) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Empty description={t('dashboard.botRequired')} />
      </PageLayout>
    );
  }

  return (
    <PageLayout embedded={embedded} className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        <MemoryPanel currentBotId={currentBotId} />
      </div>
    </PageLayout>
  );
}
