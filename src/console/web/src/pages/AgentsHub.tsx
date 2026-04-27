import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RobotOutlined, TeamOutlined, ApiOutlined } from '@ant-design/icons';
import { HubShell, type HubTabItem } from '../components/HubShell';
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

  const tabs: HubTabItem<AgentsSection>[] = useMemo(
    () => [
      {
        key: 'agents',
        icon: <RobotOutlined />,
        label: t('agentsHub.tabAgents'),
        content: <Agents embedded />,
      },
      {
        key: 'teams',
        icon: <TeamOutlined />,
        label: t('agentsHub.tabTeams'),
        content: <Teams embedded />,
      },
      {
        key: 'runtime',
        icon: <ApiOutlined />,
        label: t('agentsHub.tabRuntime'),
        content: <Runtime embedded />,
      },
    ],
    [t],
  );

  return (
    <HubShell
      title={t('agentsHub.pageTitle')}
      subtitle={t('agentsHub.pageSubtitle')}
      tabs={tabs}
      activeKey={section}
      onChange={setSectionInUrl}
    />
  );
}
