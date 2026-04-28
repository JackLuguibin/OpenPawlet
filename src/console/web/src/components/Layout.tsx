import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Button,
  Badge,
  Segmented,
  Select,
  Tooltip,
  App as AntdApp,
  Drawer,
  Layout as AntdLayout,
} from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../store';
import { isConsoleWebSocketConfigured, useWebSocket } from '../hooks/useWebSocket';
import { useBots } from '../hooks/useBots';
import { activateBot } from '../api/client';
import {
  DashboardOutlined,
  MessageOutlined,
  FolderOpenOutlined,
  SettingOutlined,
  LeftOutlined,
  RightOutlined,
  RobotOutlined,
  MenuOutlined,
  SunOutlined,
  MoonOutlined,
  DesktopOutlined,
  TeamOutlined,
  WifiOutlined,
  ScheduleOutlined,
  ApiOutlined,
  ThunderboltOutlined,
  BarChartOutlined,
  FileTextOutlined,
  BulbOutlined,
  DeploymentUnitOutlined,
} from '@ant-design/icons';

import WebSocketDebugPanel from './WebSocketDebugPanel';

const { Sider, Header, Content } = AntdLayout;

/** Lock main scroll; each page uses flex-1 min-h-0 and scrolls inside */
const LOCK_PAGE_SCROLL_PATHS = new Set([
  '/dashboard',
  '/settings',
  '/workspace',
  // Standalone pages split out of the former Hub shells; each scrolls
  // internally so the outer Content area must NOT add its own scrollbar.
  '/agents',
  '/runtime',
  '/skills',
  '/mcp',
  '/memory',
  '/activity',
  '/logs',
  '/queues',
  '/traces',
  '/channels',
  '/cron',
]);

interface LayoutProps {
  children: ReactNode;
}

type NavItem = {
  /** Stable key used for selection; not always equal to the link target. */
  key: string;
  /** Where the link navigates to (may include a query string). */
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Stronger default weight for the primary sidebar destination (e.g. Chat). */
  primary?: boolean;
  /**
   * Returns true when this item should appear active for the given location.
   * Receives `pathname` and the parsed search params for the current URL.
   */
  isActive: (pathname: string, search: URLSearchParams) => boolean;
};

type NavGroup = {
  /** Optional small uppercase header above the items; null = no header. */
  title: string | null;
  items: NavItem[];
};

function SidebarBrand({
  collapsed,
  brand,
  tagline,
}: {
  collapsed: boolean;
  brand: string;
  tagline: string;
}) {
  return (
    <div
      className={`h-14 flex items-center ${collapsed ? 'justify-center px-0' : 'px-5'}`}
    >
      <div className="flex h-7 w-7 items-center justify-center flex-shrink-0">
        <img
          src="/openpawlet-icon.png"
          alt={brand}
          className="h-7 w-7 object-contain"
        />
      </div>
      {!collapsed && (
        <div className="ml-2.5 flex flex-col">
          <span className="text-[14px] font-medium leading-tight tracking-tight text-gray-900 dark:text-white">
            {brand}
          </span>
          <span className="mt-0.5 text-[10px] uppercase tracking-[0.14em] text-gray-400 dark:text-gray-500">
            {tagline}
          </span>
        </div>
      )}
    </div>
  );
}

function SidebarNavItem({
  item,
  active,
  collapsed,
  onNavigate,
}: {
  item: NavItem;
  active: boolean;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  const primary = item.primary && !active;
  const content = (
    <Link
      to={item.to}
      onClick={onNavigate}
      className={[
        'group flex items-center rounded-md transition-colors duration-150',
        collapsed
          ? 'mx-2 h-9 justify-center'
          : 'mx-3 h-9 px-2.5 gap-3',
        active
          ? 'bg-gray-100 text-gray-900 dark:bg-white/[0.06] dark:text-white'
          : primary
            ? 'text-gray-700 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-white/[0.04] dark:hover:text-white'
            : 'text-gray-500 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-white/[0.04] dark:hover:text-white',
      ].join(' ')}
    >
      <Icon
        className={[
          'text-[16px] flex-shrink-0 transition-colors',
          active
            ? 'text-gray-900 dark:text-white'
            : primary
              ? 'text-gray-500 group-hover:text-gray-800 dark:text-gray-400 dark:group-hover:text-gray-100'
              : 'text-gray-400 group-hover:text-gray-700 dark:text-gray-500 dark:group-hover:text-gray-200',
        ].join(' ')}
      />
      {!collapsed && (
        <span
          className={[
            'text-[13px] leading-none truncate',
            item.primary ? 'font-medium' : '',
          ].join(' ')}
        >
          {item.label}
        </span>
      )}
    </Link>
  );
  if (collapsed) {
    return (
      <Tooltip title={item.label} placement="right" mouseEnterDelay={0.2}>
        {content}
      </Tooltip>
    );
  }
  return content;
}

function SidebarNav({
  groups,
  activeKey,
  collapsed,
  onNavigate,
}: {
  groups: NavGroup[];
  activeKey: string | null;
  collapsed: boolean;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex-1 overflow-y-auto no-scrollbar py-3">
      {groups.map((group, gi) => (
        <div key={gi} className={gi === 0 ? '' : 'mt-5'}>
          {group.title && !collapsed && (
            <div className="px-5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-gray-400 dark:text-gray-500">
              {group.title}
            </div>
          )}
          {group.title && collapsed && gi !== 0 && (
            <div className="mx-3 my-2 h-px bg-gray-100 dark:bg-white/[0.06]" />
          )}
          <div className="flex flex-col gap-0.5">
            {group.items.map((item) => (
              <SidebarNavItem
                key={item.key}
                item={item}
                active={activeKey === item.key}
                collapsed={collapsed}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

export default function Layout({ children }: LayoutProps) {
  const { t, i18n } = useTranslation();
  const location = useLocation();
  const {
    sidebarCollapsed,
    setSidebarCollapsed,
    theme,
    setTheme,
    wsConnected,
    wsConnecting,
    agentWsLinked,
    agentWsReady,
    currentBotId,
    setCurrentBotId,
  } = useAppStore();
  const consolePushConfigured = isConsoleWebSocketConfigured();

  // Sidebar nav: Chat (primary) + integrations/scheduling + workspace + runtime + observability + settings.
  // Each item points at a dedicated route.
  const navGroups: NavGroup[] = useMemo(() => {
    const onPath = (p: string) => (pathname: string) => pathname === p;

    return [
      // Top-level entry — Chat is the primary destination, no group header.
      {
        title: null,
        items: [
          {
            key: 'chat',
            to: '/chat',
            label: t('layout.navChat'),
            icon: MessageOutlined,
            primary: true,
            isActive: (path) => path === '/chat' || path.startsWith('/chat/'),
          },
        ],
      },
      // Integrations & scheduling — channels, jobs, heartbeat.
      {
        title: t('layout.groupControl'),
        items: [
          {
            key: 'channels',
            to: '/channels',
            label: t('layout.navChannels'),
            icon: WifiOutlined,
            isActive: onPath('/channels'),
          },
          {
            key: 'cron',
            to: '/cron',
            label: t('layout.navCron'),
            icon: ScheduleOutlined,
            isActive: onPath('/cron'),
          },
        ],
      },
      // Workspace — the assets & capabilities users build over time.
      {
        title: t('layout.groupWorkspace'),
        items: [
          {
            key: 'agent-teams',
            to: '/agents',
            label: t('layout.navAgentTeams'),
            icon: TeamOutlined,
            isActive: (path) =>
              path === '/agents' || path === '/teams' || path.startsWith('/teams/'),
          },
          {
            key: 'skills',
            to: '/skills',
            label: t('layout.navSkills'),
            icon: ThunderboltOutlined,
            isActive: onPath('/skills'),
          },
          {
            key: 'mcp',
            to: '/mcp',
            label: t('layout.navMcp'),
            icon: ApiOutlined,
            isActive: onPath('/mcp'),
          },
          {
            key: 'files',
            to: '/workspace',
            label: t('layout.navFiles'),
            icon: FolderOpenOutlined,
            isActive: onPath('/workspace'),
          },
        ],
      },
      // Runtime — processes and execution view (ops).
      {
        title: t('layout.groupRuntime'),
        items: [
          {
            key: 'runtime',
            to: '/runtime',
            label: t('agentsHub.tabRuntime'),
            icon: DeploymentUnitOutlined,
            isActive: onPath('/runtime'),
          },
        ],
      },
      // Observability — health of the system from summary to raw logs.
      {
        title: t('layout.groupObservability'),
        items: [
          {
            key: 'dashboard',
            to: '/dashboard',
            label: t('layout.navDashboard'),
            icon: DashboardOutlined,
            isActive: onPath('/dashboard'),
          },
          {
            key: 'activity',
            to: '/activity',
            label: t('layout.navActivity'),
            icon: BarChartOutlined,
            isActive: onPath('/activity'),
          },
          {
            key: 'logs',
            to: '/logs',
            label: t('layout.navLogs'),
            icon: FileTextOutlined,
            isActive: onPath('/logs'),
          },
        ],
      },
      // Settings — system-level configuration.
      {
        title: t('layout.groupSettings'),
        items: [
          {
            key: 'memory-profile',
            to: '/memory',
            label: t('layout.navMemoryAndProfile'),
            icon: BulbOutlined,
            isActive: (path) => path === '/memory' || path === '/bot-profile',
          },
          {
            key: 'settings',
            to: '/settings',
            label: t('layout.navSettings'),
            icon: SettingOutlined,
            isActive: onPath('/settings'),
          },
        ],
      },
    ];
  }, [t]);

  useWebSocket();

  const { data: bots = [] } = useBots();
  const queryClient = useQueryClient();
  const { message: messageApi } = AntdApp.useApp();

  const activeBotId = currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id || null;

  useEffect(() => {
    if (bots.length > 0 && !currentBotId && activeBotId) {
      setCurrentBotId(activeBotId);
    }
  }, [bots, currentBotId, activeBotId, setCurrentBotId]);

  const handleBotChange = async (nextBotId: string) => {
    if (!nextBotId || nextBotId === currentBotId) return;
    const previous = currentBotId;
    setCurrentBotId(nextBotId);
    try {
      await activateBot(nextBotId);
      await queryClient.invalidateQueries();
    } catch (err) {
      setCurrentBotId(previous);
      const detail = err instanceof Error ? err.message : String(err);
      messageApi.error(`Failed to activate bot: ${detail}`);
    }
  };

  const wsUi = useMemo(() => {
    if (consolePushConfigured) {
      if (wsConnected) {
        return {
          label: t('layout.wsConnected'),
          badge: 'success' as const,
          title: t('layout.wsTitleConnected'),
        };
      }
      if (wsConnecting) {
        return {
          label: t('layout.wsConnecting'),
          badge: 'processing' as const,
          title: t('layout.wsTitleConnecting'),
        };
      }
      return {
        label: t('layout.wsDisconnected'),
        badge: 'error' as const,
        title: t('layout.wsTitleDisconnected'),
      };
    }
    if (agentWsLinked) {
      if (agentWsReady) {
        return {
          label: t('layout.wsAgentReady'),
          badge: 'success' as const,
          title: t('layout.wsTitleAgentReady'),
        };
      }
      return {
        label: t('layout.wsAgentConnecting'),
        badge: 'processing' as const,
        title: t('layout.wsTitleAgentConnecting'),
      };
    }
    return {
      label: t('layout.wsLivePushOff'),
      badge: 'default' as const,
      title: t('layout.wsTitleLivePushOff'),
    };
  }, [agentWsLinked, agentWsReady, consolePushConfigured, t, wsConnected, wsConnecting]);

  const botSelectOptions = useMemo(
    () =>
      bots.map((b) => ({
        value: b.id,
        label: (
          <span className="flex items-center gap-1.5">
            <RobotOutlined className="flex-shrink-0" />
            <span>{b.name}</span>
            {b.is_default && (
              <span className="text-[10px] text-blue-500">{t('common.defaultBot')}</span>
            )}
          </span>
        ),
      })),
    [bots, t],
  );

  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  // Resolve the active sidebar item by walking the configured groups in order.
  // Each item declares its own `isActive` predicate so we can distinguish
  // panels that share a pathname (e.g. /observability with different ?section).
  const activeNavKey = useMemo(() => {
    const search = new URLSearchParams(location.search);
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.isActive(location.pathname, search)) return item.key;
      }
    }
    return null;
  }, [navGroups, location.pathname, location.search]);

  const renderSidebar = (collapsed: boolean, onNavigate?: () => void) => (
    <div className="flex h-full flex-col bg-white dark:bg-gray-950">
      <SidebarBrand
        collapsed={collapsed}
        brand={t('layout.brand')}
        tagline={t('layout.tagline')}
      />
      <SidebarNav
        groups={navGroups}
        activeKey={activeNavKey}
        collapsed={collapsed}
        onNavigate={onNavigate}
      />
      <div className={`py-2 ${collapsed ? 'px-2' : 'px-3'}`}>
        <Button
          type="text"
          size="small"
          block
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          icon={sidebarCollapsed ? <RightOutlined /> : <LeftOutlined />}
          className="!h-8 !text-gray-400 hover:!text-gray-700 dark:hover:!text-gray-200 !justify-start !pl-2"
        >
          {!collapsed && (
            <span className="text-[12px]">{t('layout.collapse')}</span>
          )}
        </Button>
      </div>
    </div>
  );

  return (
    <AntdLayout className="flex min-h-0 flex-1 overflow-hidden bg-transparent">
      <Button
        type="text"
        onClick={() => setMobileMenuOpen(true)}
        className="lg:!hidden !fixed top-3 left-3 z-50 !bg-white dark:!bg-gray-950 !border !border-gray-200 dark:!border-gray-800"
        aria-label={t('layout.openMenu')}
        icon={<MenuOutlined />}
      />

      <Drawer
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        placement="left"
        width={248}
        className="lg:!hidden"
        styles={{ body: { padding: 0 } }}
        title={null}
        closable={false}
      >
        {renderSidebar(false, () => setMobileMenuOpen(false))}
      </Drawer>

      <Sider
        collapsed={sidebarCollapsed}
        collapsedWidth={64}
        width={224}
        trigger={null}
        breakpoint="lg"
        className="!hidden lg:!block !bg-transparent border-r border-gray-100 dark:border-white/[0.06]"
        theme="light"
      >
        {renderSidebar(sidebarCollapsed)}
      </Sider>

      <AntdLayout className="flex-1 min-w-0 flex flex-col overflow-hidden bg-transparent">
        <Header className="!h-12 !leading-none !px-4 lg:!px-6 !bg-white dark:!bg-gray-950 border-b border-gray-100 dark:border-white/[0.06] flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-2 min-w-0 pl-10 lg:pl-0">
            <button
              type="button"
              title={wsUi.title}
              onClick={() => window.location.reload()}
              className="inline-flex h-7 items-center gap-1.5 rounded px-1.5 text-[12px] leading-none text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors"
            >
              <Badge status={wsUi.badge} />
              <span className="text-[12px]">{wsUi.label}</span>
            </button>
            {bots.length > 0 && (
              <>
                <span className="h-3 w-px bg-gray-200 dark:bg-white/[0.08]" />
                <Select
                  size="small"
                  variant="borderless"
                  value={activeBotId}
                  onChange={(val) => void handleBotChange(val)}
                  className="min-w-[140px]"
                  options={botSelectOptions}
                  popupMatchSelectWidth={false}
                />
              </>
            )}
          </div>
          <div className="flex items-center gap-1.5">
            <WebSocketDebugPanel />
            <Select
              size="small"
              variant="borderless"
              value={i18n.language.startsWith('zh') ? 'zh' : 'en'}
              onChange={(lng) => void i18n.changeLanguage(lng)}
              options={[
                { value: 'zh', label: t('layout.langZhShort') },
                { value: 'en', label: t('layout.langEnShort') },
              ]}
              className="w-[64px]"
              aria-label={t('layout.language')}
            />
            <Segmented
              size="small"
              value={theme}
              onChange={(val) => setTheme(val as 'light' | 'dark' | 'system')}
              options={[
                { value: 'light', icon: <SunOutlined /> },
                { value: 'dark', icon: <MoonOutlined /> },
                { value: 'system', icon: <DesktopOutlined /> },
              ]}
            />
          </div>
        </Header>

        <Content
          className={`flex-1 min-h-0 flex flex-col bg-transparent ${
            location.pathname.startsWith('/chat') ||
            location.pathname.startsWith('/teams/') ||
            LOCK_PAGE_SCROLL_PATHS.has(location.pathname)
              ? 'overflow-hidden'
              : 'overflow-y-auto'
          }`}
        >
          {children}
        </Content>
      </AntdLayout>
    </AntdLayout>
  );
}
