import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ConfigProvider, theme as antdTheme, App as AntdApp, Spin } from 'antd';
import enUS from 'antd/locale/en_US';
import zhCN from 'antd/locale/zh_CN';
import { lazy, Suspense, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from './store';
import Layout from './components/Layout';
import ToastBridge from './components/ToastBridge';
import { ErrorBoundary } from './components/ErrorBoundary';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const ChatHub = lazy(() => import('./pages/ChatHub'));
const Workspace = lazy(() => import('./pages/Workspace'));
const Settings = lazy(() => import('./pages/Settings'));
const TeamDetail = lazy(() => import('./pages/TeamDetail'));

// Standalone pages — each former Hub tab now lives at its own URL so that
// the new sidebar can deep-link directly into the panel users want.
const AgentTeamsPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.AgentTeamsPage })),
);
const RuntimePage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.RuntimePage })),
);
const SkillsPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.SkillsPage })),
);
const McpPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.McpPage })),
);
const MemoryProfilePage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.MemoryProfilePage })),
);
const ActivityPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.ActivityPage })),
);
const LogsPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.LogsPage })),
);
const QueuesPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.QueuesPage })),
);
const TracesPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.TracesPage })),
);
const ChannelsPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.ChannelsPage })),
);
const CronPage = lazy(() =>
  import('./pages/standalone').then((m) => ({ default: m.CronPage })),
);

function resolveIsDark(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function PageLoading() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 w-full flex-col items-center justify-center gap-3">
      <Spin size="large" />
      <span className="text-sm text-gray-500 dark:text-gray-400">{t('app.pageLoading')}</span>
    </div>
  );
}

/**
 * Map legacy `?section=` / `?tab=` deep links onto the new dedicated routes.
 *
 * The previous app used Hub pages with sub-tabs encoded in the query string
 * (e.g. `/agents?section=runtime` -> `/runtime`). Bookmarks stay valid.
 */
const LEGACY_REDIRECTS: Record<string, Record<string, string>> = {
  '/agents': { runtime: '/runtime' },
  '/knowledge': {
    skills: '/skills',
    mcp: '/mcp',
    memory: '/memory',
    profile: '/memory?section=profile',
  },
  '/observability': {
    health: '/dashboard',
    trace: '/traces',
    activity: '/activity',
    logs: '/logs',
    queues: '/queues',
  },
  '/settings': { channels: '/channels', cron: '/cron' },
};

function LegacyDeepLinkRedirect() {
  const location = useLocation();
  const navigate = useNavigate();
  useEffect(() => {
    const table = LEGACY_REDIRECTS[location.pathname];
    if (!table) return;
    const params = new URLSearchParams(location.search);
    const key = location.pathname === '/settings' ? 'tab' : 'section';
    const value = params.get(key);
    const target = value ? table[value] : undefined;
    if (target) {
      navigate(target, { replace: true });
    }
  }, [location.pathname, location.search, navigate]);
  return null;
}

function AppRoutes() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <LegacyDeepLinkRedirect />
      <Layout>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/chat" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chat" element={<ChatHub />} />
            <Route path="/chat/:sessionKey" element={<ChatHub />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/teams/:teamId" element={<TeamDetail />} />

            {/* Independent pages — each used to live as a tab inside an
                AgentsHub / KnowledgeHub / ObservabilityHub shell. */}
            <Route path="/agents" element={<AgentTeamsPage />} />
            <Route path="/teams" element={<Navigate to="/agents?section=teams" replace />} />
            <Route path="/runtime" element={<RuntimePage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/mcp" element={<McpPage />} />
            <Route path="/memory" element={<MemoryProfilePage />} />
            <Route path="/bot-profile" element={<Navigate to="/memory?section=profile" replace />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="/logs" element={<LogsPage />} />
            <Route path="/queues" element={<QueuesPage />} />
            <Route path="/traces" element={<TracesPage />} />
            <Route path="/channels" element={<ChannelsPage />} />
            <Route path="/cron" element={<CronPage />} />

            {/* Legacy hub URLs and ?section= deep links — redirect to the
                new dedicated routes so old bookmarks keep working. */}
            <Route path="/sessions" element={<Navigate to="/chat" replace />} />
            <Route path="/knowledge" element={<Navigate to="/skills" replace />} />
            <Route path="/observability" element={<Navigate to="/dashboard" replace />} />
          </Routes>
        </Suspense>
      </Layout>
      <ToastBridge />
    </div>
  );
}

function App() {
  const { theme } = useAppStore();
  const { i18n } = useTranslation();
  const [isDark, setIsDark] = useState(() => resolveIsDark(theme));
  const antdLocale = i18n.language.startsWith('zh') ? zhCN : enUS;

  useEffect(() => {
    setIsDark(resolveIsDark(theme));
    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => setIsDark(mq.matches);
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }
  }, [theme]);

  return (
    <ConfigProvider
      locale={antdLocale}
      theme={{
        algorithm: isDark ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        // Minimal, line-driven, airy look:
        // - small radius (4) keeps edges crisp without feeling pill-shaped
        // - tighter control heights (32) give the page more breathing room
        // - cooler neutral border colors emphasize lines over fills/shadows
        // - line width 1px everywhere for consistent stroke weight
        token: {
          colorPrimary: '#2563eb',
          borderRadius: 4,
          borderRadiusLG: 6,
          borderRadiusSM: 4,
          lineWidth: 1,
          controlHeight: 32,
          fontSize: 13,
          fontFamily: '"Plus Jakarta Sans", Inter, system-ui, -apple-system, sans-serif',
          colorBgContainer: isDark ? undefined : '#ffffff',
          colorBgElevated: isDark ? undefined : '#ffffff',
          colorBorder: isDark ? '#1f2937' : '#e5e7eb',
          colorBorderSecondary: isDark ? '#111827' : '#f1f5f9',
          boxShadow: 'none',
          boxShadowSecondary: '0 1px 2px rgba(15, 23, 42, 0.04)',
          boxShadowTertiary: 'none',
          wireframe: false,
        },
        components: {
          Card: {
            borderRadiusLG: 6,
            borderRadius: 4,
            paddingLG: 16,
            // Use a flat, line-only surface; cards get their hierarchy from
            // borders and spacing instead of drop shadows.
            boxShadowTertiary: 'none',
          },
          Button: {
            borderRadius: 4,
            controlHeight: 32,
            controlHeightSM: 26,
            controlHeightLG: 38,
            primaryShadow: 'none',
            defaultShadow: 'none',
            dangerShadow: 'none',
            fontWeight: 500,
          },
          Input: { borderRadius: 4, controlHeight: 32, paddingBlock: 5 },
          InputNumber: { borderRadius: 4, controlHeight: 32 },
          Select: { borderRadius: 4, controlHeight: 32 },
          DatePicker: { borderRadius: 4, controlHeight: 32 },
          Tabs: {
            cardPadding: '6px 14px',
            horizontalItemPadding: '8px 14px',
            horizontalMargin: '0 0 12px 0',
            inkBarColor: '#2563eb',
            itemSelectedColor: isDark ? '#ffffff' : '#0f172a',
            itemHoverColor: isDark ? '#e5e7eb' : '#0f172a',
            titleFontSize: 13,
          },
          Segmented: {
            borderRadius: 4,
            controlHeight: 28,
            itemSelectedBg: isDark ? '#1f2937' : '#ffffff',
          },
          Switch: { trackHeight: 20, trackMinWidth: 36 },
          Collapse: {
            borderRadiusLG: 4,
            contentPadding: '12px 16px',
            headerPadding: '10px 14px',
          },
          Menu: {
            itemBorderRadius: 4,
            itemMarginInline: 6,
            itemHeight: 36,
            itemSelectedBg: isDark ? 'rgba(37, 99, 235, 0.16)' : 'rgba(37, 99, 235, 0.08)',
            itemSelectedColor: isDark ? '#ffffff' : '#0f172a',
            itemHoverBg: isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(15, 23, 42, 0.04)',
          },
          Modal: { borderRadiusLG: 6 },
          Drawer: { borderRadiusLG: 0 },
          Form: { itemMarginBottom: 14, labelFontSize: 13 },
          Alert: { borderRadiusLG: 4 },
          Table: { borderRadius: 4, headerBg: isDark ? '#0b1220' : '#fafbfc' },
          Tag: { borderRadiusSM: 3, defaultBg: isDark ? '#0b1220' : '#fafbfc' },
          Badge: { dotSize: 6 },
          Tooltip: { borderRadius: 4 },
          Popover: { borderRadiusLG: 6 },
          Notification: { borderRadiusLG: 6 },
          Message: { borderRadiusLG: 6 },
        },
      }}
    >
      <AntdApp className="flex min-h-0 flex-1 flex-col">
        <ErrorBoundary>
          <AppRoutes />
        </ErrorBoundary>
      </AntdApp>
    </ConfigProvider>
  );
}

export default App;
