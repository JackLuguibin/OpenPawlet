import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Brain, UserCircle } from 'lucide-react';
import { Spin, Empty, Card } from 'antd';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';
import { formatQueryError, isNotFoundError } from '../utils/errors';
import { BotProfilePanel } from './BotProfile';

type MemorySubTab = 'long_term' | 'history';
type MainSection = 'memory' | 'profile';

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

const SECTION_QUERY = 'section';

function readSection(searchParams: URLSearchParams): MainSection {
  return searchParams.get(SECTION_QUERY) === 'profile' ? 'profile' : 'memory';
}

export default function Memory() {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const [searchParams, setSearchParams] = useSearchParams();
  const mainSection = readSection(searchParams);

  const setMainSectionInUrl = useCallback(
    (section: MainSection) => {
      if (section === 'profile') {
        setSearchParams({ [SECTION_QUERY]: 'profile' }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    },
    [setSearchParams],
  );

  const mainTabs: { key: MainSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'memory',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Brain className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('memoryAndProfile.sectionMemory')}
          </span>
        ),
      },
      {
        key: 'profile',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <UserCircle className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('memoryAndProfile.sectionProfile')}
          </span>
        ),
      },
    ],
    [t],
  );

  const memorySubTabs: { key: MemorySubTab; label: string }[] = useMemo(
    () => [
      { key: 'long_term', label: t('memory.tabLong') },
      { key: 'history', label: t('memory.tabHistory') },
    ],
    [t],
  );
  const [activeMemoryTab, setActiveMemoryTab] = useState<MemorySubTab>('long_term');

  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

  const { data: memory, isLoading, error } = useQuery({
    queryKey: ['memory', currentBotId],
    queryFn: () => api.getMemory(currentBotId),
    enabled: Boolean(currentBotId) && mainSection === 'memory',
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
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 overflow-hidden">
        <div className="shrink-0 rounded-2xl border border-gray-200/80 bg-white/70 shadow-sm shadow-gray-900/[0.03] backdrop-blur-sm dark:border-gray-700/50 dark:bg-gray-800/50">
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              {t('memoryAndProfile.pageTitle')}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t('memoryAndProfile.pageSubtitle')}
            </p>
            <div className="mt-4 border-t border-gray-200/70 pt-4 dark:border-gray-700/60">
              <SegmentedTabs
                ariaLabel={t('memoryAndProfile.ariaMainSections')}
                tabs={mainTabs}
                value={mainSection}
                onChange={setMainSectionInUrl}
                fullWidth
                margins="none"
                className="w-full"
              />
            </div>
          </div>
        </div>

        {mainSection === 'profile' ? (
          <BotProfilePanel currentBotId={currentBotId} />
        ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4">
          <SegmentedTabs
            ariaLabel={t('memory.title')}
            tabs={memorySubTabs}
            value={activeMemoryTab}
            onChange={setActiveMemoryTab}
            size="sm"
            margins="none"
          />

          {isLoading ? (
            <div className="flex min-h-0 flex-1 items-center justify-center py-12">
              <Spin />
            </div>
          ) : error ? (
            <Empty
              description={<span className="text-red-500">{errorDescription}</span>}
            />
          ) : activeMemoryTab === 'long_term' ? (
            <Card
              className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/70 bg-white/90 shadow-sm shadow-gray-900/[0.04] dark:border-gray-700/50 dark:bg-gray-800/50 dark:shadow-none"
              styles={{ body: { padding: '1.5rem 1.75rem 2rem', flex: 1, minHeight: 0, overflowY: 'auto' } }}
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
        </div>
        )}
      </div>
    </PageLayout>
  );
}
