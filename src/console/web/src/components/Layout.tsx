import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Menu, Button, Badge, Segmented, Select } from 'antd';
import { useTranslation } from 'react-i18next';
import type { MenuProps } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { useAppStore } from '../store';
import { isConsoleWebSocketConfigured, useWebSocket } from '../hooks/useWebSocket';
import * as api from '../api/client';
import {
  LayoutDashboard,
  MessageSquare,
  FolderOpen,
  Smartphone,
  Plug,
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
  BookOpen,
  Brain,
  UserCircle,
  Clock,
  Heart,
  Activity,
} from 'lucide-react';

import WebSocketDebugPanel from './WebSocketDebugPanel';

/** Lock main scroll; each page uses flex-1 min-h-0 and scrolls inside */
const LOCK_PAGE_SCROLL_PATHS = new Set([
  '/sessions',
  '/settings',
  '/channels',
  '/cron',
  '/health',
  '/activity',
  '/mcp',
  '/memory',
  '/workspace',
  '/agents',
  '/bot-profile',
  '/logs',
  '/skills',
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
          { path: '/mcp', label: t('layout.navMcp'), icon: Plug },
          { path: '/memory', label: t('layout.navMemory'), icon: Brain },
          { path: '/workspace', label: t('layout.navWorkspace'), icon: FolderOpen },
          { path: '/agents', label: t('layout.navAgents'), icon: Users },
          { path: '/bot-profile', label: t('layout.navProfile'), icon: UserCircle },
          { path: '/logs', label: t('layout.navLogs'), icon: FileText },
          { path: '/skills', label: t('layout.navSkills'), icon: BookOpen },
        ],
      },
      {
        title: t('layout.sectionManagement'),
        items: [{ path: '/settings', label: t('layout.navSettings'), icon: Settings }],
      },
    ],
    [t],
  );

  const wsStatusLabel = consolePushConfigured
    ? wsConnected
      ? t('layout.wsConnected')
      : wsConnecting
        ? t('layout.wsConnecting')
        : t('layout.wsDisconnected')
    : agentWsLinked
      ? agentWsReady
        ? t('layout.wsAgentReady')
        : t('layout.wsAgentConnecting')
      : t('layout.wsLivePushOff');

  const wsBadgeStatus = consolePushConfigured
    ? wsConnected
      ? 'success'
      : wsConnecting
        ? 'processing'
        : 'error'
    : agentWsLinked
      ? agentWsReady
        ? 'success'
        : 'processing'
      : 'default';

  const wsStatusTitle = consolePushConfigured
    ? wsConnected
      ? t('layout.wsTitleConnected')
      : wsConnecting
        ? t('layout.wsTitleConnecting')
        : t('layout.wsTitleDisconnected')
    : agentWsLinked
      ? agentWsReady
        ? t('layout.wsTitleAgentReady')
        : t('layout.wsTitleAgentConnecting')
      : t('layout.wsTitleLivePushOff');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  useWebSocket();

  const { data: bots = [] } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

  const activeBotId = currentBotId || bots.find(b => b.is_default)?.id || bots[0]?.id || null;

  useEffect(() => {
    if (bots.length > 0 && !currentBotId && activeBotId) {
      setCurrentBotId(activeBotId);
    }
  }, [bots, currentBotId, activeBotId, setCurrentBotId]);

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
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        className="lg:hidden fixed top-3 left-3 z-50 p-2 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 shadow-md"
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
          <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-600 shadow-lg shadow-primary-500/25">
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
              title={wsStatusTitle}
              onClick={() => window.location.reload()}
              className="inline-flex h-6 items-center gap-2 rounded-md px-2 text-xs leading-none text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            >
              <Badge
                status={wsBadgeStatus}
                className={
                  consolePushConfigured && !wsConnected && !wsConnecting
                    ? 'opacity-90'
                    : !consolePushConfigured &&
                        agentWsLinked &&
                        !agentWsReady
                      ? 'opacity-90'
                      : ''
                }
              />
              <span className="text-xs text-gray-600 dark:text-gray-400">
                {wsStatusLabel}
              </span>
            </button>
            {bots.length > 0 && (
              <Select
                size="small"
                value={activeBotId}
                onChange={(val) => setCurrentBotId(val)}
                className="min-w-[140px]"
                options={bots.map(b => ({
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
                }))}
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
            location.pathname.startsWith('/chat') || LOCK_PAGE_SCROLL_PATHS.has(location.pathname)
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
