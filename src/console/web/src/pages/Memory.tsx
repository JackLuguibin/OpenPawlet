import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card, Select } from 'antd';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';

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

export default function Memory() {
  const { t } = useTranslation();
  const { currentBotId, setCurrentBotId } = useAppStore();
  const tabs: { key: TabKey; label: string }[] = useMemo(
    () => [
      { key: 'long_term', label: t('memory.tabLong') },
      { key: 'history', label: t('memory.tabHistory') },
    ],
    [t],
  );
  const [activeTab, setActiveTab] = useState<TabKey>('long_term');

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

  const { data: memory, isLoading, error } = useQuery({
    queryKey: ['memory', currentBotId],
    queryFn: () => api.getMemory(currentBotId),
  });

  const historyEntries = memory?.history ? parseHistoryEntries(memory.history) : [];
  const longTermContent = memory?.long_term?.trim() ?? '';

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('memory.title')}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{t('memory.subtitle')}</p>
        </div>
        {bots && bots.length > 1 && (
          <Select
            value={currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id}
            onChange={setCurrentBotId}
            options={bots.map((b) => ({ label: b.name, value: b.id }))}
            className="w-40"
          />
        )}
      </div>

      <div className="flex gap-1 p-1 rounded-xl bg-gray-100/80 dark:bg-gray-800/50 border border-gray-200/60 dark:border-gray-700/50 w-fit shrink-0 mt-4 mb-3">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setActiveTab(key)}
            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === key
                ? 'bg-white dark:bg-gray-700/80 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-12">
          <Spin />
        </div>
      ) : error ? (
        <Empty
          description={
            <span className="text-red-500">
              {String(error).includes('404') ? t('memory.workspaceNotFound') : String(error)}
            </span>
          }
        />
      ) : activeTab === 'long_term' ? (
        <Card
          className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow"
          styles={{ body: { padding: '2rem 2.5rem', flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {longTermContent ? (
            <div className="max-w-3xl">
              <div
                className="
                  prose prose-slate dark:prose-invert max-w-none
                  prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-gray-900 dark:prose-headings:text-gray-100
                  prose-h2:text-lg prose-h2:mt-8 prose-h2:mb-4 prose-h2:pb-2 prose-h2:border-b prose-h2:border-gray-200 dark:prose-h2:border-gray-600
                  prose-h3:text-base prose-h3:mt-6 prose-h3:mb-3
                  prose-p:leading-relaxed prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-p:my-2
                  prose-li:marker:text-primary-500 prose-ul:my-3 prose-ol:my-3
                  prose-strong:text-gray-900 dark:prose-strong:text-gray-100
                  prose-hr:my-8 prose-hr:border-gray-200 dark:prose-hr:border-gray-600
                  prose-a:text-primary-600 dark:prose-a:text-primary-400 prose-a:no-underline hover:prose-a:underline
                "
              >
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
                key={idx}
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
    </div>
  );
}
