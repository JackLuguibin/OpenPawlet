import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Spin, Empty } from 'antd';
import {
  BookOutlined,
  ApiOutlined,
  BulbOutlined,
  UserOutlined,
} from '@ant-design/icons';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { HubShell, type HubTabItem } from '../components/HubShell';
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

  const tabs: HubTabItem<KnowledgeSection>[] = useMemo(
    () => [
      {
        key: 'skills',
        icon: <BookOutlined />,
        label: t('knowledgeHub.tabSkills'),
        content: <Skills embedded />,
      },
      {
        key: 'mcp',
        icon: <ApiOutlined />,
        label: t('knowledgeHub.tabMcp'),
        content: <MCPServersPanel embedded />,
      },
      {
        key: 'memory',
        icon: <BulbOutlined />,
        label: t('knowledgeHub.tabMemory'),
        content: (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <MemoryPanel currentBotId={currentBotId} />
          </div>
        ),
      },
      {
        key: 'profile',
        icon: <UserOutlined />,
        label: t('knowledgeHub.tabProfile'),
        content: (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <BotProfilePanel currentBotId={currentBotId} />
          </div>
        ),
      },
    ],
    [t, currentBotId],
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
    <HubShell
      title={t('knowledgeHub.pageTitle')}
      subtitle={t('knowledgeHub.pageSubtitle')}
      tabs={tabs}
      activeKey={section}
      onChange={setSectionInUrl}
    />
  );
}
