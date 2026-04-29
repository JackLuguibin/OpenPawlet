import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { RobotOutlined, TeamOutlined } from '@ant-design/icons';
import Agents from '../Agents';
import Teams from '../Teams';
import { HubShell, type HubTabItem } from '../../components/HubShell';

type AgentTeamsSection = 'agents' | 'teams';

const AGENT_TEAMS_SECTION_QUERY = 'section';
const VALID_AGENT_TEAMS_SECTIONS: ReadonlyArray<AgentTeamsSection> = ['agents', 'teams'];

function readAgentTeamsSection(searchParams: URLSearchParams): AgentTeamsSection {
  const raw = searchParams.get(AGENT_TEAMS_SECTION_QUERY) as AgentTeamsSection | null;
  return raw && VALID_AGENT_TEAMS_SECTIONS.includes(raw) ? raw : 'agents';
}

/** Agents + Teams in one shell; tab is driven by `?section=agents|teams`. */
export default function AgentTeamsPage() {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readAgentTeamsSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: AgentTeamsSection) => {
      if (next === 'agents') {
        setSearchParams({}, { replace: true });
      } else {
        setSearchParams({ [AGENT_TEAMS_SECTION_QUERY]: next }, { replace: true });
      }
    },
    [setSearchParams],
  );

  const tabs: HubTabItem<AgentTeamsSection>[] = useMemo(
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
    ],
    [t],
  );

  return (
    <HubShell
      title={t('layout.navAgentTeams')}
      subtitle={t('agentsHub.agentTeamsSubtitle')}
      tabs={tabs}
      activeKey={section}
      onChange={setSectionInUrl}
    />
  );
}
