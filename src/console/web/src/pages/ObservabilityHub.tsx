import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  BarChartOutlined,
  BranchesOutlined,
  FileTextOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';
import { HubShell, type HubTabItem } from '../components/HubShell';
import Observability from './Observability';
import Activity from './Activity';
import Logs from './Logs';
import Queues from './Queues';

type ObsSection = 'trace' | 'activity' | 'logs' | 'queues';

const SECTION_QUERY = 'section';
const VALID_SECTIONS: ReadonlyArray<ObsSection> = ['trace', 'activity', 'logs', 'queues'];

function readSection(searchParams: URLSearchParams): ObsSection {
  const raw = searchParams.get(SECTION_QUERY) as ObsSection | null;
  if (raw && VALID_SECTIONS.includes(raw)) return raw;
  // The Observability subpage also uses ?trace_id=... as a deeplink; default to
  // the trace tab when a trace_id is provided so the link target shows up.
  if (searchParams.get('trace_id')) return 'trace';
  return 'trace';
}

export default function ObservabilityHub() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: ObsSection) => {
      const params = new URLSearchParams(searchParams);
      params.delete('trace_id');
      if (next === 'trace') {
        params.delete(SECTION_QUERY);
      } else {
        params.set(SECTION_QUERY, next);
      }
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  const tabs: HubTabItem<ObsSection>[] = useMemo(
    () => [
      {
        key: 'trace',
        icon: <BarChartOutlined />,
        label: t('observabilityHub.tabTrace'),
        content: <Observability embedded />,
      },
      {
        key: 'activity',
        icon: <BranchesOutlined />,
        label: t('observabilityHub.tabActivity'),
        content: <Activity embedded />,
      },
      {
        key: 'logs',
        icon: <FileTextOutlined />,
        label: t('observabilityHub.tabLogs'),
        content: <Logs embedded />,
      },
      {
        key: 'queues',
        icon: <DeploymentUnitOutlined />,
        label: t('observabilityHub.tabQueues'),
        content: <Queues embedded />,
      },
    ],
    [t],
  );

  return (
    <HubShell
      title={t('observabilityHub.pageTitle')}
      subtitle={t('observabilityHub.pageSubtitle')}
      tabs={tabs}
      activeKey={section}
      onChange={setSectionInUrl}
    />
  );
}
