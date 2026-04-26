import { useCallback, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Heart, BarChart2, Activity as ActivityIcon, FileText, Cable } from 'lucide-react';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import Health from './Health';
import Observability from './Observability';
import Activity from './Activity';
import Logs from './Logs';
import Queues from './Queues';

type ObsSection = 'health' | 'trace' | 'activity' | 'logs' | 'queues';

const SECTION_QUERY = 'section';
const VALID_SECTIONS: ReadonlyArray<ObsSection> = [
  'health',
  'trace',
  'activity',
  'logs',
  'queues',
];

function readSection(searchParams: URLSearchParams): ObsSection {
  const raw = searchParams.get(SECTION_QUERY) as ObsSection | null;
  if (raw && VALID_SECTIONS.includes(raw)) return raw;
  // The Observability subpage also uses ?trace_id=... as a deeplink; default to
  // the trace tab when a trace_id is provided so the link target shows up.
  if (searchParams.get('trace_id')) return 'trace';
  return 'health';
}

export default function ObservabilityHub() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: ObsSection) => {
      const params = new URLSearchParams(searchParams);
      // Reset deeplink params that are tied to the previous tab.
      params.delete('trace_id');
      if (next === 'health') {
        params.delete(SECTION_QUERY);
      } else {
        params.set(SECTION_QUERY, next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const tabs: { key: ObsSection; label: ReactNode }[] = useMemo(
    () => [
      {
        key: 'health',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Heart className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('observabilityHub.tabHealth')}
          </span>
        ),
      },
      {
        key: 'trace',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <BarChart2 className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('observabilityHub.tabTrace')}
          </span>
        ),
      },
      {
        key: 'activity',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <ActivityIcon className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('observabilityHub.tabActivity')}
          </span>
        ),
      },
      {
        key: 'logs',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <FileText className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('observabilityHub.tabLogs')}
          </span>
        ),
      },
      {
        key: 'queues',
        label: (
          <span className="inline-flex items-center justify-center gap-1.5">
            <Cable className="h-3.5 w-3.5 opacity-80" aria-hidden />
            {t('observabilityHub.tabQueues')}
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
              {t('observabilityHub.pageTitle')}
            </h1>
            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-gray-500 dark:text-gray-400">
              {t('observabilityHub.pageSubtitle')}
            </p>
            <div className="mt-4 border-t border-gray-200/70 pt-4 dark:border-gray-700/60">
              <SegmentedTabs
                ariaLabel={t('observabilityHub.ariaTabs')}
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
          {section === 'health' && <Health embedded />}
          {section === 'trace' && <Observability embedded />}
          {section === 'activity' && <Activity embedded />}
          {section === 'logs' && <Logs embedded />}
          {section === 'queues' && <Queues embedded />}
        </div>
      </div>
    </PageLayout>
  );
}
