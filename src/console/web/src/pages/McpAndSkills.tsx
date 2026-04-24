import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, Plug } from 'lucide-react';
import { Spin, Empty } from 'antd';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import { MCPServersPanel } from './MCPServers';
import Skills from './Skills';

type MainSection = 'mcp' | 'skills';

const SECTION_QUERY = 'section';

function readSection(searchParams: URLSearchParams): MainSection {
  // Default: skills first; `?section=mcp` shows MCP
  return searchParams.get(SECTION_QUERY) === 'mcp' ? 'mcp' : 'skills';
}

export default function McpAndSkills() {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const [searchParams, setSearchParams] = useSearchParams();
  const mainSection = readSection(searchParams);

  const setMainSectionInUrl = useCallback(
    (section: MainSection) => {
      if (section === 'mcp') {
        setSearchParams({ [SECTION_QUERY]: 'mcp' }, { replace: true });
      } else {
        setSearchParams({}, { replace: true });
      }
    },
    [setSearchParams],
  );

  const mainTabs: { key: MainSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'skills',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <BookOpen className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('mcpAndSkills.sectionSkills')}
          </span>
        ),
      },
      {
        key: 'mcp',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Plug className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('mcpAndSkills.sectionMcp')}
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
              {t('mcpAndSkills.pageTitle')}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t('mcpAndSkills.pageSubtitle')}
            </p>
            <div className="mt-4 border-t border-gray-200/70 pt-4 dark:border-gray-700/60">
              <SegmentedTabs
                ariaLabel={t('mcpAndSkills.ariaMainSections')}
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

        {mainSection === 'skills' ? (
          <Skills embedded />
        ) : (
          <MCPServersPanel embedded />
        )}
      </div>
    </PageLayout>
  );
}
