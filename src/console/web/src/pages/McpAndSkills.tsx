import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { BookOutlined, ApiOutlined } from '@ant-design/icons';
import { Spin, Empty } from 'antd';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { HubShell, type HubTabItem } from '../components/HubShell';
import { MCPServersPanel } from './MCPServers';
import Skills from './Skills';

type MainSection = 'mcp' | 'skills';

const SECTION_QUERY = 'section';

function readSection(searchParams: URLSearchParams): MainSection {
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

  const tabs: HubTabItem<MainSection>[] = useMemo(
    () => [
      {
        key: 'skills',
        icon: <BookOutlined />,
        label: t('mcpAndSkills.sectionSkills'),
        content: <Skills embedded />,
      },
      {
        key: 'mcp',
        icon: <ApiOutlined />,
        label: t('mcpAndSkills.sectionMcp'),
        content: <MCPServersPanel embedded />,
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
    <HubShell
      title={t('mcpAndSkills.pageTitle')}
      subtitle={t('mcpAndSkills.pageSubtitle')}
      tabs={tabs}
      activeKey={mainSection}
      onChange={setMainSectionInUrl}
    />
  );
}
