import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, Button, Badge, Segmented, Select, App as AntdApp } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { MenuProps } from 'antd';
import { useAppStore } from '../store';
import { isConsoleWebSocketConfigured, useWebSocket } from '../hooks/useWebSocket';
import { useBots } from '../hooks/useBots';
import { activateBot } from '../api/client';
import {
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  Smartphone,
  Layers,
  Settings,
  FileText,
  ChevronLeft,
  ChevronRight,
  Bot,
  Menu as MenuIcon,
  X,
  Sun,
  Moon,
  Monitor,
  Users,
  UsersRound,
  Brain,
  Clock,
  Heart,
  Activity,
  LineChart,
  Cable,
  Cpu,
} from 'lucide-react';

import WebSocketDebugPanel from './WebSocketDebugPanel';

/** Lock main scroll; each page uses flex-1 min-h-0 and scrolls inside */
const LOCK_PAGE_SCROLL_PATHS = new Set([
  '/dashboard',
  '/sessions',
  '/settings',
  '/channels',
  '/cron',
  '/health',
  '/observability',
  '/activity',
  '/mcp',
  '/memory',
  '/workspace',
  '/agents',
  '/teams',
  '/logs',
  '/queues',
  '/runtime',
]);

interface LayoutProps {
  children: ReactNode;
}

type NavItem = {
  path: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
};

type NavSection = {
  title: string;
  items: NavItem[];
};

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

  const navSections: NavSection[] = useMemo(
    () => [
      {
        title: t('layout.sectionChat'),
        items: [
          { path: '/dashboard', label: t('layout.navOverview'), icon: LayoutDashboard },
          { path: '/chat', label: t('layout.navChat'), icon: MessageSquare },
        ],
      },
      {
        title: t('layout.sectionControl'),
        items: [
          { path: '/runtime', label: t('layout.navRuntime'), icon: Cpu },
          { path: '/channels', label: t('layout.navChannels'), icon: Smartphone },
          { path: '/sessions', label: t('layout.navSessions'), icon: FolderOpen },
          { path: '/cron', label: t('layout.navCron'), icon: Clock },
          { path: '/health', label: t('layout.navHealth'), icon: Heart },
          { path: '/activity', label: t('layout.navActivity'), icon: Activity },
        ],
      },
      {
        title: t('layout.sectionAgent'),
        items: [
          { path: '/mcp', label: t('layout.navMcpAndSkills'), icon: Layers },
          { path: '/memory', label: t('layout.navMemoryAndProfile'), icon: Brain },
          { path: '/workspace', label: t('layout.navWorkspace'), icon: FolderOpen },
          { path: '/agents', label: t('layout.navAgents'), icon: Users },
          { path: '/teams', label: t('layout.navTeams'), icon: UsersRound },
          { path: '/observability', label: t('layout.navObservability'), icon: LineChart },
        ],
      },
      {
        title: t('layout.sectionManagement'),
        items: [
          { path: '/queues', label: t('layout.navQueues'), icon: Cable },
          { path: '/logs', label: t('layout.navLogs'), icon: FileText },
          { path: '/settings', label: t('layout.navSettings'), icon: Settings },
        ],
      },
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
      // Ask the server to swap the embedded runtime to the selected bot.
      // While the swap runs, server-side queries hit a degraded runtime
      // briefly; we invalidate downstream queries so the SPA refetches
      // once the new runtime is up.
      await activateBot(nextBotId);
      await queryClient.invalidateQueries();
    } catch (err) {
      // Roll back on failure so the SPA does not lie about the active
      // runtime to the user.
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
          badgeClass: '',
        };
      }
      if (wsConnecting) {
        return {
          label: t('layout.wsConnecting'),
          badge: 'processing' as const,
          title: t('layout.wsTitleConnecting'),
          badgeClass: '',
        };
      }
      return {
        label: t('layout.wsDisconnected'),
        badge: 'error' as const,
        title: t('layout.wsTitleDisconnected'),
        badgeClass: 'opacity-90',
      };
    }
    if (agentWsLinked) {
      if (agentWsReady) {
        return {
          label: t('layout.wsAgentReady'),
          badge: 'success' as const,
          title: t('layout.wsTitleAgentReady'),
          badgeClass: '',
        };
      }
      return {
        label: t('layout.wsAgentConnecting'),
        badge: 'processing' as const,
        title: t('layout.wsTitleAgentConnecting'),
        badgeClass: 'opacity-90',
      };
    }
    return {
      label: t('layout.wsLivePushOff'),
      badge: 'default' as const,
      title: t('layout.wsTitleLivePushOff'),
      badgeClass: '',
    };
  }, [
    agentWsLinked,
    agentWsReady,
    consolePushConfigured,
    t,
    wsConnected,
    wsConnecting,
  ]);

  const botSelectOptions = useMemo(
    () =>
      bots.map((b) => ({
        value: b.id,
        label: (
          <span className="flex items-center gap-1.5">
            <Bot className="w-3.5 h-3.5 flex-shrink-0" />
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
  const mobileNavId = 'nb-mobile-sidebar';

  const selectedKey = '/' + (location.pathname.split('/')[1] || 'dashboard');

  const menuItems: MenuProps['items'] = useMemo(() => navSections.map((section) => ({
    type: 'group',
    label: section.title,
    children: section.items.map((item) => {
      const Icon = item.icon;
      return {
        key: item.path,
        icon: <Icon className="w-4 h-4" />,
        label: (
          <Link to={item.path} onClick={() => setMobileMenuOpen(false)}>
            {item.label}
          </Link>
        ),
      };
    }),
  })), [navSections]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Mobile Menu Button */}
      <button
        type="button"
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded-md bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-md"
        aria-expanded={mobileMenuOpen}
        aria-controls={mobileNavId}
        aria-label={mobileMenuOpen ? t('layout.closeMenu') : t('layout.openMenu')}
      >
        {mobileMenuOpen ? <X className="w-5 h-5" /> : <MenuIcon className="w-5 h-5" />}
      </button>

      {/* Mobile Overlay */}
      {mobileMenuOpen && (
        <div
          className="lg:hidden fixed inset-0 bg-black/50 z-30"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        id={mobileNavId}
        className={`
          ${sidebarCollapsed ? 'w-20' : 'w-64'}
          ${mobileMenuOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
          fixed lg:relative z-40 min-h-screen lg:h-full lg:min-h-0
          bg-gradient-to-b from-white via-white to-gray-50 dark:from-gray-900 dark:via-gray-800 dark:to-gray-900
          border-r border-gray-200/50 dark:border-gray-700/50
          flex flex-col transition-all duration-300 ease-out
          shadow-[4px_0_24px_rgba(0,0,0,0.02)] dark:shadow-none
        `}
      >
        {/* Logo */}
        <div className="h-16 flex items-center px-4 border-b border-gray-200/50 dark:border-gray-700/50 bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm">
          <div className="flex items-center justify-center w-10 h-10 rounded-md bg-gradient-to-br from-primary-500 to-primary-600 shadow-lg shadow-primary-500/25">
            <Bot className="w-5 h-5 text-white" />
          </div>
          {!sidebarCollapsed && (
            <div className="ml-3 flex flex-col">
              <span className="font-bold text-lg bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
                {t('layout.brand')}
              </span>
              <span className="text-[10px] text-gray-400 -mt-0.5">{t('layout.tagline')}</span>
            </div>
          )}
        </div>

        {/* Navigation using antd Menu */}
        <nav className="flex-1 overflow-y-auto no-scrollbar py-2">
          <Menu
            mode="inline"
            selectedKeys={[selectedKey]}
            inlineCollapsed={sidebarCollapsed}
            items={menuItems}
            style={{ background: 'transparent', borderRight: 'none' }}
          />
        </nav>

        {/* Collapse Button - Desktop Only */}
        <div className="hidden lg:block px-2 py-1 border-t border-gray-200/50 dark:border-gray-700/50">
          <Button
            type="text"
            size="small"
            block
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            icon={
              sidebarCollapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )
            }
          >
            {!sidebarCollapsed && t('layout.collapse')}
          </Button>
        </div>

      </aside>

      {/* Main Content */}
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Global Header */}
        <header className="nb-app-header shrink-0 sticky top-0 z-20 h-16 flex items-center justify-between pl-14 pr-4 pt-[env(safe-area-inset-top,0px)] lg:pl-6 lg:pt-0 border-b border-gray-200/50 dark:border-gray-700/50 bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              title={wsUi.title}
              onClick={() => window.location.reload()}
              className="inline-flex h-6 items-center gap-2 rounded px-2 text-xs leading-none text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              <Badge status={wsUi.badge} className={wsUi.badgeClass} />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {wsUi.label}
              </span>
            </button>
            {bots.length > 0 && (
              <Select
                size="small"
                value={activeBotId}
                onChange={(val) => void handleBotChange(val)}
                className="min-w-[140px]"
                options={botSelectOptions}
                popupMatchSelectWidth={false}
              />
            )}
          </div>
          <div className="flex items-center gap-1">
            <WebSocketDebugPanel />
            <Select
              size="small"
              value={i18n.language.startsWith('zh') ? 'zh' : 'en'}
              onChange={(lng) => void i18n.changeLanguage(lng)}
              options={[
                { value: 'zh', label: t('layout.langZhShort') },
                { value: 'en', label: t('layout.langEnShort') },
              ]}
              className="w-[72px]"
              aria-label={t('layout.language')}
            />
            <Segmented
              size="small"
              value={theme}
              onChange={(val) => setTheme(val as 'light' | 'dark' | 'system')}
              className="[&_.ant-segmented-item]:flex [&_.ant-segmented-item]:items-center [&_.ant-segmented-item]:justify-center [&_.ant-segmented-item-label]:flex [&_.ant-segmented-item-label]:h-full [&_.ant-segmented-item-label]:items-center [&_.ant-segmented-item-label]:justify-center"
              options={[
                { value: 'light', icon: <Sun className="w-4 h-4 shrink-0" /> },
                { value: 'dark', icon: <Moon className="w-4 h-4 shrink-0" /> },
                { value: 'system', icon: <Monitor className="w-4 h-4 shrink-0" /> },
              ]}
            />
          </div>
        </header>

        <div
          className={`flex-1 min-h-0 flex flex-col ${
            location.pathname.startsWith('/chat') ||
            location.pathname.startsWith('/teams/') ||
            LOCK_PAGE_SCROLL_PATHS.has(location.pathname)
              ? 'overflow-hidden'
              : 'overflow-y-auto'
          }`}
        >
          {children}
        </div>
      </main>
    </div>
  );
}
