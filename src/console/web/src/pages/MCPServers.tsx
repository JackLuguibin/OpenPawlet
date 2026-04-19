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
  Select,
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
import { Plug } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';

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

export default function MCPServers() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId, setCurrentBotId } = useAppStore();
  const [selectedServer, setSelectedServer] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

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
          : `${result.name}: ${result.message || 'Test failed'}`,
      });
      queryClient.invalidateQueries({ queryKey: ['mcp'] });
    },
    onError: (err) => {
      addToast({ type: 'error', message: String(err) });
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
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="bleed">
        <Alert
          type="error"
          title="加载 MCP 服务器失败"
          description={String(error)}
          showIcon
        />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed">
      {/* Header */}
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            MCP Servers
          </h1>
          <p className="text-sm text-gray-500 mt-1 hidden sm:block">
            管理 Model Context Protocol 服务器，扩展 AI 能力
          </p>
        </div>
        <Space>
          {bots && bots.length > 1 && (
            <Select
              value={currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id}
              onChange={setCurrentBotId}
              options={bots.map((b) => ({ label: b.name, value: b.id }))}
              className="w-40"
            />
          )}
          <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
            <span className="hidden sm:inline">刷新</span>
          </Button>
        </Space>
      </div>

      {/* Content: Empty state or Server list */}
      {mcpServers && mcpServers.length > 0 ? (
        <div className="flex-1 min-h-0 overflow-y-auto space-y-6 mt-4">
          {/* Server Cards */}
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
                } rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40`}
                size="small"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div
                      className={`p-3 rounded-xl ${
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
                        类型: <span className="font-medium">{server.server_type}</span>
                      </Text>
                    </div>
                  </div>

                  <Space>
                    <Tag color={statusColor(server.status)}>{server.status}</Tag>
                    <Button
                      icon={<ThunderboltOutlined />}
                      loading={testing === server.name}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTest(server.name);
                      }}
                      size="small"
                    >
                      测试
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
                    最后连接: {new Date(server.last_connected).toLocaleString()}
                  </p>
                )}
              </Card>
            ))}
          </div>

          {/* Server Detail Panel */}
          {selectedServerData && (
            <Card
              className="rounded-2xl border border-gray-200/80 dark:border-gray-700/60"
              title={
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-xl bg-purple-100 dark:bg-purple-900/30">
                    <ApiOutlined className="text-purple-600 text-lg" />
                  </div>
                  <div>
                    <span className="font-semibold text-lg">{selectedServerData.name}</span>
                    <p className="text-xs text-gray-500 font-normal">服务器详情</p>
                  </div>
                </div>
              }
              extra={
                <Button
                  icon={<ThunderboltOutlined />}
                  loading={testing === selectedServerData.name}
                  onClick={() => handleTest(selectedServerData.name)}
                >
                  测试连接
                </Button>
              }
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">连接状态</p>
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
                        {selectedServerData.status}
                      </span>
                    </div>
                  </div>
                </Card>

                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">服务器类型</p>
                    <div className="flex items-center gap-2">
                      <ApiOutlined className="text-purple-500 text-xl" />
                      <span className="text-lg font-semibold">
                        {selectedServerData.server_type}
                      </span>
                    </div>
                  </div>
                </Card>

                <Card size="small" className="bg-gray-50 dark:bg-gray-700/30 border-0">
                  <div>
                    <p className="text-xs text-gray-500 mb-2">最后连接</p>
                    <div className="flex items-center gap-2">
                      <ClockCircleOutlined className="text-gray-400 text-xl" />
                      <span className="text-base font-semibold">
                        {selectedServerData.last_connected
                          ? new Date(selectedServerData.last_connected).toLocaleString()
                          : '从未'}
                      </span>
                    </div>
                  </div>
                </Card>
              </div>

              <Descriptions
                title="服务器信息"
                size="small"
                bordered
                items={[
                  { key: 'name', label: '名称', children: selectedServerData.name },
                  {
                    key: 'type',
                    label: '类型',
                    children: selectedServerData.server_type,
                  },
                  {
                    key: 'status',
                    label: '状态',
                    children: (
                      <Space>
                        <Badge status={statusBadge(selectedServerData.status)} />
                        <Tag color={statusColor(selectedServerData.status)}>
                          {selectedServerData.status}
                        </Tag>
                      </Space>
                    ),
                  },
                  {
                    key: 'last_connected',
                    label: '最后连接',
                    children: selectedServerData.last_connected
                      ? new Date(selectedServerData.last_connected).toLocaleString()
                      : '从未',
                  },
                ]}
              />

              {selectedServerData.error && (
                <Alert
                  className="mt-4"
                  type="error"
                  title="错误详情"
                  description={selectedServerData.error}
                  showIcon
                />
              )}
            </Card>
          )}

          {/* Config reference when servers exist */}
          {!selectedServerData && (
            <Card
              title="配置参考"
              className="rounded-2xl border border-gray-200/80 dark:border-gray-700/60"
            >
              <Alert
                title={
                  <span>
                    在 config.json 的{' '}
                    <code className="px-1.5 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs font-mono">
                      tools.mcpServers
                    </code>{' '}
                    下添加 MCP 服务器配置
                  </span>
                }
                type="info"
                showIcon
                className="mb-4"
              />
              <pre className="p-5 bg-gray-900 dark:bg-gray-950 rounded-xl overflow-x-auto text-sm text-gray-100 font-mono">
                {EXAMPLE_CONFIG}
              </pre>
            </Card>
          )}
        </div>
      ) : (
        <div className="mt-2 flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto">
          <Card
            className="w-full min-w-0 flex-1 rounded-xl border border-gray-200/90 bg-white shadow-sm dark:border-gray-700/80 dark:bg-gray-800/50 dark:shadow-none"
            styles={{ body: { padding: 0 } }}
          >
            <div className="border-b border-gray-100 bg-gray-50/80 px-4 py-3 dark:border-gray-700/60 dark:bg-gray-900/30 sm:px-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4">
                <div className="flex shrink-0 justify-center sm:justify-start">
                  <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-600 dark:bg-gray-800">
                    <Plug
                      className="h-6 w-6 text-indigo-600 dark:text-indigo-400"
                      strokeWidth={1.35}
                    />
                  </div>
                </div>
                <div className="min-w-0 flex-1 text-center sm:text-left">
                  <h2 className="text-base font-semibold tracking-tight text-gray-900 dark:text-gray-100 sm:text-lg">
                    尚未配置 MCP 服务器
                  </h2>
                  <p className="mx-auto mt-1 max-w-3xl text-xs leading-snug text-gray-600 dark:text-gray-400 sm:mx-0 sm:text-[13px]">
                    MCP 用于接入外部工具与数据源。在配置里加入{' '}
                    <code className="rounded px-1 py-0.5 font-mono text-[11px] text-gray-800 dark:bg-gray-700 dark:text-gray-200">
                      mcpServers
                    </code>{' '}
                    后在此查看连接状态。
                  </p>
                </div>
              </div>
            </div>

            <div className="grid gap-3 p-3 sm:p-4 lg:grid-cols-2 lg:gap-5 lg:items-start">
              <section className="min-w-0 space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">
                  什么是 MCP？
                </h3>
                <div className="rounded-lg border border-gray-200 bg-gray-50/90 p-2.5 text-xs leading-snug text-gray-700 dark:border-gray-600/80 dark:bg-gray-900/40 dark:text-gray-300 sm:text-[13px] sm:leading-relaxed">
                  <p className="flex gap-2">
                    <InfoCircleOutlined className="mt-0.5 shrink-0 text-indigo-500 dark:text-indigo-400" />
                    <span>
                      开放协议，供 AI 安全调用外部工具；常见场景：文件、浏览器、仓库、数据库等。
                    </span>
                  </p>
                </div>
              </section>

              <section className="min-w-0 space-y-1.5">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">配置步骤</h3>
                <ol className="list-decimal space-y-1 rounded-lg border border-gray-200 bg-white py-2 pl-8 pr-2.5 text-xs text-gray-700 dark:border-gray-600/80 dark:bg-gray-900/25 dark:text-gray-300 sm:text-[13px] sm:leading-snug">
                  <li>
                    编辑 config.json，或打开{' '}
                    <Link
                      to="/settings"
                      className="font-medium text-indigo-600 hover:text-indigo-500 dark:text-indigo-400"
                    >
                      <SettingOutlined /> 设置
                    </Link>
                  </li>
                  <li>
                    在{' '}
                    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-700">
                      tools
                    </code>{' '}
                    下添加{' '}
                    <code className="rounded bg-gray-100 px-1 py-0.5 font-mono text-[11px] dark:bg-gray-700">
                      mcpServers
                    </code>
                  </li>
                  <li>保存并重启 Bot</li>
                </ol>
              </section>
            </div>

            <div className="border-t border-gray-100 px-3 pb-3 pt-1.5 dark:border-gray-700/60 sm:px-4">
              <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                <h3 className="text-xs font-semibold text-gray-900 dark:text-gray-100">示例配置</h3>
                <Button
                  type="link"
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={copyConfig}
                  className="h-7 px-1 text-indigo-600 dark:text-indigo-400"
                >
                  复制
                </Button>
              </div>
              <div className="overflow-hidden rounded-md border border-gray-800/90">
                <pre className="m-0 bg-[#0d1117] p-2.5 text-[11px] leading-tight text-gray-100 font-mono dark:bg-[#0a0a0f] sm:p-3 sm:text-xs sm:leading-snug">
                  {EXAMPLE_CONFIG}
                </pre>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <Link to="/settings">
                  <Button type="primary" size="small" icon={<SettingOutlined />}>
                    前往设置
                  </Button>
                </Link>
                <Button size="small" icon={<ReloadOutlined />} onClick={() => refetch()}>
                  刷新状态
                </Button>
              </div>
            </div>
          </Card>
        </div>
      )}
    </PageLayout>
  );
}
