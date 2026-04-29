/**
 * Shared chrome for standalone route wrappers — keep this module lean so each
 * route chunk only pulls what it imports.
 */
import { useTranslation } from 'react-i18next';
import { Empty, Spin } from 'antd';
import { useAppStore } from '../../store';
import { useBots } from '../../hooks/useBots';
import { PageLayout } from '../../components/PageLayout';
import { PageHeader } from '../../components/PageHeader';

type StandalonePageProps =
  | { showHeader?: true; title: string; subtitle?: string; children: React.ReactNode }
  | { showHeader: false; children: React.ReactNode };

/** Shared page chrome: optional header + a flex column that fills the remaining height. */
export function StandalonePage(props: StandalonePageProps) {
  const showHeader = props.showHeader !== false;
  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {showHeader && 'title' in props ? (
          <PageHeader title={props.title} subtitle={props.subtitle} />
        ) : null}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">{props.children}</div>
      </div>
    </PageLayout>
  );
}

/**
 * Bot-scoped panels: show loading / empty bot states before rendering children.
 */
export function BotScopeGate({ children }: { children: (botId: string | null) => React.ReactNode }) {
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
