import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  Badge,
  Button,
  Spin,
  Alert,
  Tag,
  Descriptions,
  Space,
  Typography,
} from 'antd';
import {
  ReloadOutlined,
  ThunderboltOutlined,
  ApiOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  ClockCircleOutlined,
  SettingOutlined,
  CopyOutlined,
} from '@ant-design/icons';
import type { TFunction } from 'i18next';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import type { MCPStatus } from '../api/types';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';
import { formatQueryError } from '../utils/errors';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleString } from '../utils/agentDatetime';

const { Text } = Typography;

const EXAMPLE_CONFIG = `{
  "tools": {
    "mcpServers": {
      "filesystem": {
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
      },
      "cursor-ide-browser": {
        "command": "npx",
        "args": ["-y", "@anthropic-ai/mcp-server-cursor-ide-browser"]
      }
    }
  }
}`;

function mcpStatusLabel(status: MCPStatus['status'], t: TFunction): string {
  return t(`mcp.status.${status}`);
}

export function MCPServersPanel({
  embedded = false,
  /** Standalone /mcp route: one Cron-style title+subtitle+actions row (hub tabs keep toolbar only). */
  standaloneSurface = false,
}: {
  embedded?: boolean;
  standaloneSurface?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const { data: mcpServers, isLoading, error, refetch } = useQuery({
    queryKey: ['mcp', currentBotId],
    queryFn: () => api.getMCPServers(currentBotId),
  });

  const testMutation = useMutation({
    mutationFn: (name: string) => api.testMCPConnection(name, currentBotId),
    onSuccess: (result) => {
      addToast({
        type: result.success ? 'success' : 'error',
        message: result.success
          ? `${result.name}: ${result.message}${result.latency_ms ? ` (${result.latency_ms}ms)` : ''}`
          : `${result.name}: ${result.message || t('mcp.testFailed')}`,
      });
      queryClient.invalidateQueries({ queryKey: ['mcp'] });
    },
    onError: (err) => {
      addToast({ type: 'error', message: formatQueryError(err) });
    },
    onSettled: () => setTesting(null),
  });

  const handleTest = (name: string) => {
    setTesting(name);
    testMutation.mutate(name);
  };

  const statusBadge = (status: string) => {
    if (status === 'connected') return 'success' as const;
    if (status === 'error') return 'error' as const;
    return 'default' as const;
  };

  const statusColor = (status: string) => {
    if (status === 'connected') return 'success';
    if (status === 'error') return 'error';
    return 'default';
  };

  const selectedServerData = mcpServers?.find((s) => s.name === selectedServer);

  const copyConfig = async () => {
    try {
      await navigator.clipboard.writeText(EXAMPLE_CONFIG);
      addToast({ type: 'success', message: t('mcp.copied') });
    } catch {
      addToast({ type: 'error', message: t('mcp.copyFailed') });
    }
  };

  if (isLoading) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="bleed" embedded={embedded} className={embedded ? '' : 'gap-6 md:p-8'}>
        <Alert
          type="error"
          title={t('mcp.loadFailed')}
          description={formatQueryError(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  const refreshButtons = (
    <Space className="w-full sm:w-auto justify-end flex-wrap">
      <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
        <span className="hidden sm:inline">{t('common.refresh')}</span>
      </Button>
    </Space>
  );

  const showCronHeadingRow = !embedded || standaloneSurface;

  const headerRow = showCronHeadingRow ? (
    <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h1 className={PAGE_PRIMARY_TITLE_CLASS}>{t('mcp.pageTitle')}</h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 max-w-xl leading-relaxed">
          {t('mcp.subtitle')}
        </p>
      </div>
      {refreshButtons}
    </div>
  ) : (
    <div className="flex shrink-0 flex-col gap-4 sm:flex-row sm:items-center sm:justify-end">
      {refreshButtons}
    </div>
  );

  const main = (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-hidden">
      {headerRow}

      {mcpServers && mcpServers.length > 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-6">
          <div className="space-y-3">
            {mcpServers.map((server) => (
              <Card
                key={server.name}
                hoverable
                onClick={() =>
                  setSelectedServer(selectedServer === server.name ? null : server.name)
                }
                className={`cursor-pointer transition-all ${
                  selectedServer === server.name
                    ? 'border-blue-500 border-2 shadow-md shadow-blue-500/10'
                    : ''
                } rounded-md border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40`}
                size="small"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div
                      className={`p-3 rounded ${
                        server.status === 'connected'
                          ? 'bg-green-100 dark:bg-green-900/30'
                          : server.status === 'error'
                            ? 'bg-red-100 dark:bg-red-900/30'
                            : 'bg-gray-100 dark:bg-gray-700'
                      }`}
                    >
                      <ApiOutlined
                        className={`text-lg ${
                          server.status === 'connected'
                            ? 'text-green-600'
                            : server.status === 'error'
                              ? 'text-red-600'
                              : 'text-gray-400'
                        }`}
                      />
                    </div>
                    <div>
                      <p className="font-semibold text-base">{server.name}</p>
                      <Text type="secondary" className="text-sm">
                        {t('mcp.typePrefix')}{' '}
                        <span className="font-medium">{server.server_type}</span>
                      </Text>
                    </div>
                  </div>

                  <Space>
                    <Tag color={statusColor(server.status)}>
                      {mcpStatusLabel(server.status, t)}
                    </Tag>
                    <Button
                      icon={<ThunderboltOutlined />}
                      loading={testing === server.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTest(server.name);
                      }}
                      size="small"
                    >
                      {t('mcp.test')}
                    </Button>
                  </Space>
                </div>

                {server.error && (
                  <Alert
                    className="mt-3"
                    type="error"
                    showIcon
                    icon={<ExclamationCircleOutlined />}
                    title={server.error}
                  />
                )}

                {server.last_connected && (
                  <p className="mt-2 text-xs text-gray-500 flex items-center gap-1">
                    <ClockCircleOutlined />
                    {t('mcp.lastConnectedPrefix')}{' '}
                    {formatAgentLocaleString(server.last_connected, agentTz, locale)}
                  </p>
                )}
              </Card>
            ))}
          </div>

          {selectedServerData && (
            <Card
              className="rounded-md border border-gray-200/80 dark:border-gray-700/60"
              title={
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded bg-purple-100 dark:bg-purple-900/30">
                    <ApiOutlined className="text-purple-600 text-lg" />
                  </div>
                  <div>
                    <span className="font-semibold text-lg">{selectedServerData.name}</span>
                    <p className="text-xs text-gray-500 font-normal">{t('mcp.serverDetailSubtitle')}</p>
                  </div>
                </div>
              }
              extra={
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={testing === selectedServerData.name}
                  onClick={() => handleTest(selectedServerData.name)}
                >
                  {t('mcp.testConnection')}
                </Button>
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">{t('mcp.connectionStatus')}</p>
                    <div className="flex items-center gap-2">
                      {selectedServerData.status === 'connected' ? (
                        <CheckCircleOutlined className="text-green-500 text-xl" />
                      ) : selectedServerData.status === 'error' ? (
                        <CloseCircleOutlined className="text-red-500 text-xl" />
                      ) : (
                        <ExclamationCircleOutlined className="text-gray-400 text-xl" />
                      )}
                      <span
                        className={`text-lg font-semibold ${
                          selectedServerData.status === 'connected'
                            ? 'text-green-600'
                            : selectedServerData.status === 'error'
                              ? 'text-red-600'
                              : 'text-gray-500'
                        }`}
                      >
                        {mcpStatusLabel(selectedServerData.status, t)}
                      </span>
                    </div>
                  </div>
                </Card>

                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">{t('mcp.serverType')}</p>
                    <div className="flex items-center gap-2">
                      <ApiOutlined className="text-purple-500 text-xl" />
                      <span className="text-lg font-semibold">{selectedServerData.server_type}</span>
                    </div>
                  </div>
                </Card>

                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">{t('mcp.lastConnected')}</p>
                    <div className="flex items-center gap-2">
                      <ClockCircleOutlined className="text-gray-400 text-xl" />
                      <span className="text-base font-semibold">
                        {selectedServerData.last_connected
                          ? formatAgentLocaleString(
                              selectedServerData.last_connected,
                              agentTz,
                              locale,
                            )
                          : t('mcp.never')}
                      </span>
                    </div>
                  </div>
                </Card>
              </div>

              <Descriptions
                title={t('mcp.serverInfo')}
                size="small"
                bordered
                items={[
                  { key: 'name', label: t('mcp.fieldName'), children: selectedServerData.name },
                  {
                    key: 'type',
                    label: t('mcp.fieldType'),
                    children: selectedServerData.server_type,
                  },
                  {
                    key: 'status',
                    label: t('mcp.fieldStatus'),
                    children: (
                      <Space>
                        <Badge status={statusBadge(selectedServerData.status)} />
                        <Tag color={statusColor(selectedServerData.status)}>
                          {mcpStatusLabel(selectedServerData.status, t)}
                        </Tag>
                      </Space>
                    ),
                  },
                  {
                    key: 'last_connected',
                    label: t('mcp.lastConnected'),
                    children: selectedServerData.last_connected
                      ? formatAgentLocaleString(
                          selectedServerData.last_connected,
                          agentTz,
                          locale,
                        )
                      : t('mcp.never'),
                  },
                ]}
              />

              {selectedServerData.error && (
                <Alert
                  className="mt-4"
                  type="error"
                  title={t('mcp.errorDetail')}
                  description={selectedServerData.error}
                  showIcon
                />
              )}
            </Card>
          )}

          {!selectedServerData && (
            <Card
              title={t('mcp.configReference')}
              className="rounded-md border border-gray-200/80 dark:border-gray-700/60"
            >
              <Alert
                title={
                  <span>
                    {t('mcp.configHintBefore')}
                    <code className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">
                      {t('mcp.configPathKey')}
                    </code>
                    {t('mcp.configHintAfter')}
                  </span>
                }
                type="info"
                showIcon
                className="mb-4"
              />
              <pre className="p-5 bg-gray-900 dark:bg-gray-950 rounded-md overflow-x-auto text-sm text-gray-100 font-mono">
                {EXAMPLE_CONFIG}
              </pre>
            </Card>
          )}
        </div>
      ) : (
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto">
          <Card className="w-full min-w-0 flex-1 rounded-md border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40">
            <div className="mb-4 min-w-0 space-y-1">
              <h2 className="m-0 text-lg font-semibold tracking-tight text-gray-900 dark:text-gray-100">
                {t('mcp.emptyTitle')}
              </h2>
              <p className="m-0 max-w-3xl text-sm text-gray-500 dark:text-gray-400">
                {t('mcp.emptyLead', {
                  mcpServers: t('mcp.emptyMcpKey'),
                  tools: t('mcp.emptyToolsKey'),
                })}
              </p>
            </div>

            <div className="grid gap-3 lg:grid-cols-2 lg:gap-5 lg:items-start">
              <section className="min-w-0 space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t('mcp.whatIsTitle')}
                </h3>
                <div className="rounded-md border border-gray-200 bg-gray-50/90 p-2.5 text-xs leading-snug text-gray-700 dark:border-gray-600/80 dark:bg-gray-900/40 dark:text-gray-300 sm:text-[13px] sm:leading-relaxed">
                  <p className="flex gap-2">
                    <InfoCircleOutlined className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                    <span>{t('mcp.whatIsBody')}</span>
                  </p>
                </div>
              </section>

              <section className="min-w-0 space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t('mcp.setupTitle')}
                </h3>
                <ol className="list-decimal space-y-1 rounded-md border border-gray-200 bg-white py-2 pl-8 pr-2.5 text-xs text-gray-700 dark:border-gray-600/80 dark:bg-gray-900/25 dark:text-gray-300 sm:text-[13px] sm:leading-snug">
                  <li>
                    {t('mcp.step1Prefix')}
                    <Link
                      to="/settings"
                      className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                      <SettingOutlined /> {t('layout.navSettings')}
                    </Link>
                  </li>
                  <li>
                    {t('mcp.step2')}
                  </li>
                  <li>{t('mcp.step3')}</li>
                </ol>
              </section>
            </div>

            <div className="mt-4 border-t border-gray-100 pt-4 dark:border-gray-700/60">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  {t('mcp.exampleTitle')}
                </h3>
                <Button
                  type="link"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={copyConfig}
                  className="h-7 px-1 text-indigo-600 dark:text-indigo-400"
                >
                  {t('mcp.copyExample')}
                </Button>
              </div>
              <div className="overflow-hidden rounded border border-gray-800/90">
                <pre className="m-0 bg-[#0d1117] p-2.5 text-[11px] leading-tight text-gray-100 font-mono dark:bg-[#0a0a0f] sm:p-3 sm:text-xs sm:leading-snug">
                  {EXAMPLE_CONFIG}
                </pre>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to="/settings">
                  <Button type="primary" size="small" icon={<SettingOutlined />}>
                    {t('mcp.goSettings')}
                  </Button>
                </Link>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
                  {t('mcp.refreshStatus')}
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );

  if (embedded) {
    return (
      <PageLayout embedded className="min-h-0 flex-1 overflow-hidden">
        {main}
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed" className="gap-6 md:p-8">
      {main}
    </PageLayout>
  );
}
