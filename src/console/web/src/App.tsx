import { Routes, Route, Navigate } from 'react-router-dom';
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
const AgentsHub = lazy(() => import('./pages/AgentsHub'));
const KnowledgeHub = lazy(() => import('./pages/KnowledgeHub'));
const ObservabilityHub = lazy(() => import('./pages/ObservabilityHub'));

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

function AppRoutes() {
  return (
    <div className="flex min-h-0 flex-1 flex-col bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-gray-100">
      <Layout>
        <Suspense fallback={<PageLoading />}>
          <Routes>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/chat" element={<ChatHub />} />
            <Route path="/chat/:sessionKey" element={<ChatHub />} />
            <Route path="/agents" element={<AgentsHub />} />
            <Route path="/teams/:teamId" element={<TeamDetail />} />
            <Route path="/knowledge" element={<KnowledgeHub />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/observability" element={<ObservabilityHub />} />
            <Route path="/settings" element={<Settings />} />

            {/* Legacy routes: keep old bookmarks/share-links working by
                redirecting them into the new Hub pages with the matching
                ?section= sub-tab. */}
            <Route path="/sessions" element={<Navigate to="/chat" replace />} />
            <Route path="/runtime" element={<Navigate to="/agents?section=runtime" replace />} />
            <Route path="/teams" element={<Navigate to="/agents?section=teams" replace />} />
            <Route path="/mcp" element={<Navigate to="/knowledge?section=mcp" replace />} />
            <Route path="/skills" element={<Navigate to="/knowledge" replace />} />
            <Route path="/memory" element={<Navigate to="/knowledge?section=memory" replace />} />
            <Route
              path="/bot-profile"
              element={<Navigate to="/knowledge?section=profile" replace />}
            />
            <Route
              path="/health"
              element={<Navigate to="/observability?section=health" replace />}
            />
            <Route
              path="/activity"
              element={<Navigate to="/observability?section=activity" replace />}
            />
            <Route
              path="/logs"
              element={<Navigate to="/observability?section=logs" replace />}
            />
            <Route
              path="/queues"
              element={<Navigate to="/observability?section=queues" replace />}
            />
            <Route
              path="/channels"
              element={<Navigate to="/settings?tab=channels" replace />}
            />
            <Route path="/cron" element={<Navigate to="/settings?tab=cron" replace />} />
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
        token: {
          colorPrimary: '#3b82f6',
          borderRadius: 6,
          fontFamily: '"Plus Jakarta Sans", Inter, system-ui, -apple-system, sans-serif',
          colorBgContainer: isDark ? undefined : '#ffffff',
          colorBgElevated: isDark ? undefined : '#ffffff',
        },
        components: {
          Card: {
            borderRadiusLG: 6,
            borderRadius: 6,
          },
          Button: {
            borderRadius: 6,
            controlHeight: 36,
          },
          Input: {
            borderRadius: 6,
            controlHeight: 36,
          },
          Select: {
            borderRadius: 6,
            controlHeight: 36,
          },
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
