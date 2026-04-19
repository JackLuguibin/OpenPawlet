import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card } from 'antd';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';
import { formatQueryError, isNotFoundError } from '../utils/errors';

type TabKey = 'long_term' | 'history';

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

export default function Memory() {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const tabs: { key: TabKey; label: string }[] = useMemo(
    () => [
      { key: 'long_term', label: t('memory.tabLong') },
      { key: 'history', label: t('memory.tabHistory') },
    ],
    [t],
  );
  const [activeTab, setActiveTab] = useState<TabKey>('long_term');

  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

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

  if (botsLoading || waitingBot) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (botsFetched && bots.length === 0) {
    return (
      <PageLayout variant="bleed">
        <Empty description={t('dashboard.botRequired')} />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('memory.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('memory.subtitle')}</p>
        </div>
      </div>

      <SegmentedTabs
        ariaLabel={t('memory.title')}
        tabs={tabs}
        value={activeTab}
        onChange={setActiveTab}
      />

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-12">
          <Spin />
        </div>
      ) : error ? (
        <Empty
          description={<span className="text-red-500">{errorDescription}</span>}
        />
      ) : activeTab === 'long_term' ? (
        <Card
          className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow"
          styles={{ body: { padding: '2rem 2.5rem', flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {longTermContent ? (
            <div className="max-w-3xl">
              <div className={MARKDOWN_PROSE_CLASS}>
                <Markdown>{longTermContent}</Markdown>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-[200px]">
              <Empty description={t('memory.emptyLong')} className="text-gray-500" />
            </div>
          )}
        </Card>
      ) : (
        <div className="space-y-3 flex-1 min-h-0 overflow-y-auto">
          {historyEntries.length > 0 ? (
            historyEntries.map((entry, idx) => (
              <Card
                key={historyEntryKey(entry, idx)}
                size="small"
                className="rounded-xl border-l-4 border-l-primary-500 shadow-sm hover:shadow-md transition-all bg-white dark:bg-gray-800/50 border border-gray-100 dark:border-gray-700/50"
              >
                <div className="flex gap-4">
                  {entry.timestamp && (
                    <span className="text-xs font-mono text-primary-600 dark:text-primary-400 shrink-0 pt-0.5">
                      {entry.timestamp}
                    </span>
                  )}
                  <div className="flex-1 text-sm leading-relaxed text-gray-700 dark:text-gray-300 whitespace-pre-wrap">
                    {entry.content}
                  </div>
                </div>
              </Card>
            ))
          ) : (
            <div className="flex items-center justify-center min-h-[200px] py-12">
              <Empty description={t('memory.emptyHistory')} className="text-gray-500" />
            </div>
          )}
        </div>
      )}
    </PageLayout>
  );
}
