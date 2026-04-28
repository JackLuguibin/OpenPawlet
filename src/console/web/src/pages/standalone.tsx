/**
 * Standalone page wrappers.
 *
 * Each entry below renders one previously-tabbed sub-page as its own URL.
 * Skills/MCP standalone routes use `standaloneSurface` + `showHeader={false}` (Cron-style heading in the panel).
 * Other hubs use `PageHeader` or hide the header when the inner view already has a full title.
 * The underlying page components already
 * support an `embedded` prop (originally used to render them inside the old
 * Hub shells); we reuse it here so the inner panel does not double-pad.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { RobotOutlined, TeamOutlined, BulbOutlined, UserOutlined } from '@ant-design/icons';
import { Empty, Spin } from 'antd';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { PageHeader } from '../components/PageHeader';
import { HubShell, type HubTabItem } from '../components/HubShell';

import Agents from './Agents';
import Teams from './Teams';
import Runtime from './Runtime';
import Skills from './Skills';
import { MCPServersPanel } from './MCPServers';
import { MemoryPanel } from './Memory';
import { BotProfilePanel } from './BotProfile';
import Activity from './Activity';
import Logs from './Logs';
import Queues from './Queues';
import Observability from './Observability';
import Channels from './Channels';
import Cron from './Cron';

type StandalonePageProps =
  | { showHeader?: true; title: string; subtitle?: string; children: React.ReactNode }
  | { showHeader: false; children: React.ReactNode };

/** Shared page chrome: optional header + a flex column that fills the remaining height. */
function StandalonePage(props: StandalonePageProps) {
  const showHeader = props.showHeader !== false;
  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showHeader && 'title' in props ? (
          <PageHeader title={props.title} subtitle={props.subtitle} />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {props.children}
        </div>
      </div>
    </PageLayout>
  );
}

/**
 * Bot-scoped panels: show loading / empty bot states before rendering children.
 */
function BotScopeGate({ children }: { children: (botId: string | null) => React.ReactNode }) {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
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
  return <>{children(currentBotId)}</>;
}

// ---- Workspace group ------------------------------------------------------

type AgentTeamsSection = 'agents' | 'teams';

const AGENT_TEAMS_SECTION_QUERY = 'section';
const VALID_AGENT_TEAMS_SECTIONS: ReadonlyArray<AgentTeamsSection> = ['agents', 'teams'];

function readAgentTeamsSection(searchParams: URLSearchParams): AgentTeamsSection {
  const raw = searchParams.get(AGENT_TEAMS_SECTION_QUERY) as AgentTeamsSection | null;
  return raw && VALID_AGENT_TEAMS_SECTIONS.includes(raw) ? raw : 'agents';
}

/** Agents + Teams in one shell; tab is driven by `?section=agents|teams`. */
export function AgentTeamsPage() {
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

export function RuntimePage() {
  return (
    <StandalonePage showHeader={false}>
      <Runtime embedded />
    </StandalonePage>
  );
}

export function SkillsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Skills embedded standaloneSurface />
    </StandalonePage>
  );
}

export function McpPage() {
  return (
    <StandalonePage showHeader={false}>
      {/* Same heading row pattern as Cron (titles + actions in one strip). */}
      <MCPServersPanel embedded standaloneSurface />
    </StandalonePage>
  );
}

// ---- Insights group -------------------------------------------------------

export function ActivityPage() {
  return (
    <StandalonePage showHeader={false}>
      <Activity embedded />
    </StandalonePage>
  );
}

export function LogsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Logs embedded />
    </StandalonePage>
  );
}

export function QueuesPage() {
  return (
    <StandalonePage showHeader={false}>
      <Queues embedded />
    </StandalonePage>
  );
}

export function TracesPage() {
  return (
    <StandalonePage showHeader={false}>
      <Observability embedded />
    </StandalonePage>
  );
}

type MemoryProfileSection = 'memory' | 'profile';

const MEMORY_PROFILE_SECTION_QUERY = 'section';

function readMemoryProfileSection(searchParams: URLSearchParams): MemoryProfileSection {
  const raw = searchParams.get(MEMORY_PROFILE_SECTION_QUERY) as MemoryProfileSection | null;
  return raw === 'profile' ? 'profile' : 'memory';
}

function MemoryProfileHubInner({ botId }: { botId: string | null }) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const section = readMemoryProfileSection(searchParams);

  const setSectionInUrl = useCallback(
    (next: MemoryProfileSection) => {
      if (next === 'memory') {
        setSearchParams({}, { replace: true });
      } else {
        setSearchParams({ [MEMORY_PROFILE_SECTION_QUERY]: next }, { replace: true });
      }
    },
    [setSearchParams],
  );

  const tabs: HubTabItem<MemoryProfileSection>[] = useMemo(
    () => [
      {
        key: 'memory',
        icon: <BulbOutlined />,
        label: t('knowledgeHub.tabMemory'),
        content: (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MemoryPanel currentBotId={botId} />
          </div>
        ),
      },
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: t('knowledgeHub.tabProfile'),
        content: (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BotProfilePanel currentBotId={botId} />
          </div>
        ),
      },
    ],
    [t, botId],
  );

  return (
    <HubShell
      title={t('layout.navMemoryAndProfile')}
      subtitle={t('knowledgeHub.memoryAndProfileSubtitle')}
      tabs={tabs}
      activeKey={section}
      onChange={setSectionInUrl}
    />
  );
}

/** Memory (knowledge & long-term memory) + bot profile in one shell; `?section=profile` for profile. */
export function MemoryProfilePage() {
  return (
    <BotScopeGate>
      {(botId) => <MemoryProfileHubInner botId={botId} />}
    </BotScopeGate>
  );
}

// ---- Control group --------------------------------------------------------

export function ChannelsPage() {
  return (
    <StandalonePage showHeader={false}>
      <Channels embedded />
    </StandalonePage>
  );
}

export function CronPage() {
  return (
    <StandalonePage showHeader={false}>
      <Cron embedded />
    </StandalonePage>
  );
}
