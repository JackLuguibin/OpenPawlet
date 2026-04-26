import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plug, Brain, UserCircle } from 'lucide-react';
import { Spin, Empty } from 'antd';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { MCPServersPanel } from './MCPServers';
import { BotProfilePanel } from './BotProfile';
import { MemoryPanel } from './Memory';
import Skills from './Skills';

type KnowledgeSection = 'skills' | 'mcp' | 'memory' | 'profile';

const SECTION_QUERY = 'section';
const VALID_SECTIONS: ReadonlyArray<KnowledgeSection> = [
  'skills',
  'mcp',
  'memory',
  'profile',
];

function readSection(searchParams: URLSearchParams): KnowledgeSection {
  const raw = searchParams.get(SECTION_QUERY) as KnowledgeSection | null;
  return raw && VALID_SECTIONS.includes(raw) ? raw : 'skills';
}

export default function KnowledgeHub() {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: KnowledgeSection) => {
      if (next === 'skills') {
        setSearchParams({}, { replace: true });
      } else {
        setSearchParams({ [SECTION_QUERY]: next }, { replace: true });
      }
    },
    [setSearchParams],
  );

  const tabs: { key: KnowledgeSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'skills',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('knowledgeHub.tabSkills')}
          </span>
        ),
      },
      {
        key: 'mcp',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Plug className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('knowledgeHub.tabMcp')}
          </span>
        ),
      },
      {
        key: 'memory',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Brain className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('knowledgeHub.tabMemory')}
          </span>
        ),
      },
      {
        key: 'profile',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <UserCircle className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('knowledgeHub.tabProfile')}
          </span>
        ),
      },
    ],
    [t],
  );

  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;

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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="shrink-0 rounded-md border border-gray-200/80 bg-white/70 shadow-sm shadow-gray-900/[0.03] backdrop-blur-sm dark:border-gray-700/50 dark:bg-gray-800/50">
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              {t('knowledgeHub.pageTitle')}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t('knowledgeHub.pageSubtitle')}
            </p>
            <div className="mt-4 border-t border-gray-200/70 pt-4 dark:border-gray-700/60">
              <SegmentedTabs
                ariaLabel={t('knowledgeHub.ariaTabs')}
                tabs={tabs}
                value={section}
                onChange={setSectionInUrl}
                fullWidth
                margins="none"
                className="w-full"
              />
            </div>
          </div>
        </div>

        {section === 'skills' && <Skills embedded />}
        {section === 'mcp' && <MCPServersPanel embedded />}
        {section === 'memory' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MemoryPanel currentBotId={currentBotId} />
          </div>
        )}
        {section === 'profile' && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BotProfilePanel currentBotId={currentBotId} />
          </div>
        )}
      </div>
    </PageLayout>
  );
}
