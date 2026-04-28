import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  Menu,
  Button,
  Badge,
  Segmented,
  Select,
  App as AntdApp,
  Drawer,
  Layout as AntdLayout,
} from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { MenuProps } from 'antd';
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
  BookOutlined,
  LineChartOutlined,
} from '@ant-design/icons';

import WebSocketDebugPanel from './WebSocketDebugPanel';

const { Sider, Header, Content } = AntdLayout;

/** Lock main scroll; each page uses flex-1 min-h-0 and scrolls inside */
const LOCK_PAGE_SCROLL_PATHS = new Set([
  '/dashboard',
  '/settings',
  '/observability',
  '/knowledge',
  '/workspace',
  '/agents',
]);

interface LayoutProps {
  children: ReactNode;
}

type NavItem = {
  path: string;
  label: string;
  icon: React.ComponentType;
};

function SidebarBrand({ collapsed, brand, tagline }: { collapsed: boolean; brand: string; tagline: string }) {
  return (
    <div className="h-14 flex items-center px-4 border-b border-gray-200 dark:border-gray-800">
      <div className="flex h-8 w-8 items-center justify-center flex-shrink-0">
        <img
          src="/openpawlet-icon.png"
          alt={brand}
          className="h-8 w-8 object-contain"
        />
      </div>
      {!collapsed && (
        <div className="ml-2.5 flex flex-col">
          <span className="text-[15px] font-medium leading-tight tracking-tight text-gray-900 dark:text-white">
            {brand}
          </span>
          <span className="mt-0.5 text-[10px] uppercase tracking-[0.12em] text-gray-400">
            {tagline}
          </span>
        </div>
      )}
    </div>
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

  const navItems: NavItem[] = useMemo(
    () => [
      { path: '/dashboard', label: t('layout.navOverview'), icon: DashboardOutlined },
      { path: '/chat', label: t('layout.navChat'), icon: MessageOutlined },
      { path: '/agents', label: t('layout.navAgentsHub'), icon: TeamOutlined },
      { path: '/knowledge', label: t('layout.navKnowledge'), icon: BookOutlined },
      { path: '/workspace', label: t('layout.navWorkspace'), icon: FolderOpenOutlined },
      { path: '/observability', label: t('layout.navObservabilityHub'), icon: LineChartOutlined },
      { path: '/settings', label: t('layout.navSettings'), icon: SettingOutlined },
    ],
    [t],
  );

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

  const topLevel = '/' + (location.pathname.split('/')[1] || 'dashboard');
  // `/teams/:teamId` is rendered standalone but conceptually belongs to the
  // Agents hub; keep that nav item highlighted while users browse a team.
  const selectedKey = topLevel === '/teams' ? '/agents' : topLevel;

  const menuItems: MenuProps['items'] = useMemo(
    () =>
      navItems.map((item) => {
        const Icon = item.icon;
        return {
          key: item.path,
          icon: <Icon />,
          label: (
            <Link to={item.path} onClick={() => setMobileMenuOpen(false)}>
              {item.label}
            </Link>
          ),
        };
      }),
    [navItems],
  );

  const sidebarContent = (
    <div className="flex h-full flex-col bg-white dark:bg-gray-950">
      <SidebarBrand
        collapsed={sidebarCollapsed}
        brand={t('layout.brand')}
        tagline={t('layout.tagline')}
      />
      <nav className="flex-1 overflow-y-auto no-scrollbar py-3">
        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          inlineCollapsed={sidebarCollapsed}
          items={menuItems}
          style={{ background: 'transparent', borderRight: 'none', fontSize: 13 }}
        />
      </nav>
      <div className="px-2 py-2 border-t border-gray-200 dark:border-gray-800">
        <Button
          type="text"
          size="small"
          block
          onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
          icon={sidebarCollapsed ? <RightOutlined /> : <LeftOutlined />}
          className="!text-gray-500 hover:!text-gray-800 dark:hover:!text-gray-200"
        >
          {!sidebarCollapsed && t('layout.collapse')}
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
        width={256}
        className="lg:!hidden"
        styles={{ body: { padding: 0 } }}
        title={null}
        closable={false}
      >
        {sidebarContent}
      </Drawer>

      <Sider
        collapsed={sidebarCollapsed}
        collapsedWidth={72}
        width={232}
        trigger={null}
        breakpoint="lg"
        className="!hidden lg:!block !bg-transparent border-r border-gray-200 dark:border-gray-800"
        theme="light"
      >
        {sidebarContent}
      </Sider>

      <AntdLayout className="flex-1 min-w-0 flex flex-col overflow-hidden bg-transparent">
        <Header className="!h-14 !leading-none !px-4 lg:!px-6 !bg-white dark:!bg-gray-950 border-b border-gray-200 dark:border-gray-800 flex items-center justify-between sticky top-0 z-20">
          <div className="flex items-center gap-3 min-w-0 pl-10 lg:pl-0">
            <button
              type="button"
              title={wsUi.title}
              onClick={() => window.location.reload()}
              className="inline-flex h-7 items-center gap-2 rounded px-2 text-[12px] leading-none text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
            >
              <Badge status={wsUi.badge} />
              <span className="text-[12px] text-gray-500 dark:text-gray-400">{wsUi.label}</span>
            </button>
            {bots.length > 0 && (
              <Select
                size="small"
                variant="borderless"
                value={activeBotId}
                onChange={(val) => void handleBotChange(val)}
                className="min-w-[140px]"
                options={botSelectOptions}
                popupMatchSelectWidth={false}
              />
            )}
          </div>
          <div className="flex items-center gap-2">
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
              className="w-[68px]"
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
