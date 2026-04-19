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
  Empty,
  Space,
  Typography,
  Select,
  Steps,
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 flex flex-col flex-1 min-h-0">
        <Alert
          type="error"
          title="加载 MCP 服务器失败"
          description={String(error)}
          showIcon
        />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
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
        /* Empty state - 完整引导 */
        <div className="flex-1 min-h-0 overflow-y-auto mt-4">
          <div className="max-w-2xl mx-auto space-y-6">
            {/* 空状态卡片 */}
            <Card
              className="rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 overflow-hidden"
              styles={{ body: { padding: '2.5rem 2rem' } }}
            >
              <Empty
                image={
                  <div className="flex justify-center mb-4">
                    <div className="p-6 rounded-2xl bg-purple-50 dark:bg-purple-900/20">
                      <Plug className="w-16 h-16 text-purple-500" />
                    </div>
                  </div>
                }
                description={
                  <div className="space-y-2">
                    <p className="text-base font-medium text-gray-700 dark:text-gray-300">
                      尚未配置 MCP 服务器
                    </p>
                    <p className="text-sm text-gray-500 max-w-md mx-auto">
                      MCP (Model Context Protocol) 允许 AI 接入外部工具与数据源，如文件系统、浏览器、数据库等。
                    </p>
                  </div>
                }
              />

              {/* 什么是 MCP */}
              <div className="mt-8 p-4 rounded-xl bg-gray-50 dark:bg-gray-800/50 border border-gray-200/60 dark:border-gray-700/50">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2 flex items-center gap-2">
                  <InfoCircleOutlined />
                  什么是 MCP？
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 leading-relaxed">
                  Model Context Protocol 是一种开放协议，让 AI 助手能够安全地调用外部工具。
                  常见 MCP 服务器包括：文件系统访问、网页浏览、代码仓库操作、数据库查询等。
                </p>
              </div>

              {/* 配置步骤 */}
              <div className="mt-6">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4">
                  配置步骤
                </h3>
                <Steps
                  orientation="vertical"
                  size="small"
                  items={[
                    {
                      title: '编辑配置文件',
                      content: (
                        <span>
                          打开 Bot 的 config.json，或前往{' '}
                          <Link to="/settings" className="text-blue-600 hover:underline">
                            <SettingOutlined /> 设置
                          </Link>{' '}
                          页面查看配置
                        </span>
                      ),
                    },
                    {
                      title: '添加 mcpServers',
                      content: (
                        <span>
                          在 <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs">tools</code> 下添加{' '}
                          <code className="px-1 py-0.5 bg-gray-200 dark:bg-gray-700 rounded text-xs">mcpServers</code> 对象
                        </span>
                      ),
                    },
                    {
                      title: '重启 Bot',
                      content: '保存配置后重启 Bot 使 MCP 服务器生效',
                    },
                  ]}
                />
              </div>

              {/* 示例配置 */}
              <div className="mt-8">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">
                    示例配置
                  </h3>
                  <Button
                    type="link"
                    size="small"
                    icon={<CopyOutlined />}
                    onClick={copyConfig}
                  >
                    复制
                  </Button>
                </div>
                <pre className="p-5 bg-gray-900 dark:bg-gray-950 rounded-xl overflow-x-auto text-sm text-gray-100 font-mono">
                  {EXAMPLE_CONFIG}
                </pre>
              </div>

              {/* 快捷操作 */}
              <div className="mt-6 flex flex-wrap gap-3">
                <Link to="/settings">
                  <Button type="primary" icon={<SettingOutlined />}>
                    前往设置
                  </Button>
                </Link>
                <Button icon={<ReloadOutlined />} onClick={() => refetch()}>
                  刷新状态
                </Button>
              </div>
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}
