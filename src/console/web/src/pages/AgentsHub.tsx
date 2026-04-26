import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Bot, UsersRound, Cpu } from 'lucide-react';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import Agents from './Agents';
import Teams from './Teams';
import Runtime from './Runtime';

type AgentsSection = 'agents' | 'teams' | 'runtime';

const SECTION_QUERY = 'section';
const VALID_SECTIONS: ReadonlyArray<AgentsSection> = ['agents', 'teams', 'runtime'];

function readSection(searchParams: URLSearchParams): AgentsSection {
  const raw = searchParams.get(SECTION_QUERY) as AgentsSection | null;
  return raw && VALID_SECTIONS.includes(raw) ? raw : 'agents';
}

export default function AgentsHub() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: AgentsSection) => {
      if (next === 'agents') {
        setSearchParams({}, { replace: true });
      } else {
        setSearchParams({ [SECTION_QUERY]: next }, { replace: true });
      }
    },
    [setSearchParams],
  );

  const tabs: { key: AgentsSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'agents',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Bot className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('agentsHub.tabAgents')}
          </span>
        ),
      },
      {
        key: 'teams',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <UsersRound className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('agentsHub.tabTeams')}
          </span>
        ),
      },
      {
        key: 'runtime',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Cpu className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('agentsHub.tabRuntime')}
          </span>
        ),
      },
    ],
    [t],
  );

  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="shrink-0 rounded-md border border-gray-200/80 bg-white/70 shadow-sm shadow-gray-900/[0.03] backdrop-blur-sm dark:border-gray-700/50 dark:bg-gray-800/50">
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-white">
              {t('agentsHub.pageTitle')}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t('agentsHub.pageSubtitle')}
            </p>
            <div className="mt-4 border-t border-gray-200/70 pt-4 dark:border-gray-700/60">
              <SegmentedTabs
                ariaLabel={t('agentsHub.ariaTabs')}
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

        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {section === 'agents' && <Agents embedded />}
          {section === 'teams' && <Teams embedded />}
          {section === 'runtime' && <Runtime embedded />}
        </div>
      </div>
    </PageLayout>
  );
}
