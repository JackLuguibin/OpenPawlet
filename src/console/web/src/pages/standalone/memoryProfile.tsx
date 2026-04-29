import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BulbOutlined, UserOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router-dom';
import { MemoryPanel } from '../Memory';
import { BotProfilePanel } from '../BotProfile';
import { HubShell, type HubTabItem } from '../../components/HubShell';
import { BotScopeGate } from './chrome';

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

/** Memory + bot profile in one shell; `?section=profile` for profile. */
export default function MemoryProfilePage() {
  return (
    <BotScopeGate>{(botId) => <MemoryProfileHubInner botId={botId} />}</BotScopeGate>
  );
}
