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
const Chat = lazy(() => import('./pages/Chat'));
const Sessions = lazy(() => import('./pages/Sessions'));
const Channels = lazy(() => import('./pages/Channels'));
const McpAndSkills = lazy(() => import('./pages/McpAndSkills'));
const Settings = lazy(() => import('./pages/Settings'));
const Logs = lazy(() => import('./pages/Logs'));
const Agents = lazy(() => import('./pages/Agents'));
const Memory = lazy(() => import('./pages/Memory'));
const Cron = lazy(() => import('./pages/Cron'));
const Health = lazy(() => import('./pages/Health'));
const Observability = lazy(() => import('./pages/Observability'));
const Workspace = lazy(() => import('./pages/Workspace'));
const Activity = lazy(() => import('./pages/Activity'));
const Queues = lazy(() => import('./pages/Queues'));

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
            <Route path="/chat" element={<Chat />} />
            <Route path="/chat/:sessionKey" element={<Chat />} />
            <Route path="/sessions" element={<Sessions />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/cron" element={<Cron />} />
            <Route path="/health" element={<Health />} />
            <Route path="/observability" element={<Observability />} />
            <Route path="/workspace" element={<Workspace />} />
            <Route path="/mcp" element={<McpAndSkills />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/skills" element={<Navigate to="/mcp" replace />} />
            <Route path="/memory" element={<Memory />} />
            <Route
              path="/bot-profile"
              element={<Navigate to="/memory?section=profile" replace />}
            />
            <Route path="/settings" element={<Settings />} />
            <Route path="/logs" element={<Logs />} />
            <Route path="/activity" element={<Activity />} />
            <Route path="/queues" element={<Queues />} />
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
