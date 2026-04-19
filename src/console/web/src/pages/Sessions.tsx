import { useState, useRef, useLayoutEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Table,
  Button,
  Input,
  Popconfirm,
  Space,
  Segmented,
  Typography,
  Tag,
  Descriptions,
  Card,
  Tooltip,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  PlusOutlined,
  DeleteOutlined,
  MessageOutlined,
  ClockCircleOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { useAppStore } from '../store';
import type { SessionInfo } from '../api/types';

const { Text } = Typography;

/** Split `channel:id` session keys for compact display */
function parseSessionChannel(key: string): { channel: string | null; idPart: string } {
  const idx = key.indexOf(':');
  if (idx <= 0) return { channel: null, idPart: key };
  return { channel: key.slice(0, idx), idPart: key.slice(idx + 1) };
}

const CHANNEL_TAG_COLOR: Record<string, string> = {
  weixin: 'green',
  websocket: 'gold',
  telegram: 'blue',
  discord: 'purple',
  slack: 'geekblue',
  whatsapp: 'cyan',
  feishu: 'blue',
  dingtalk: 'processing',
  email: 'default',
  qq: 'cyan',
  matrix: 'magenta',
  mochat: 'success',
  wecom: 'blue',
  msteams: 'purple',
};

export default function Sessions() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'messages'>('updated');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const tableScrollBoxRef = useRef<HTMLDivElement>(null);
  const [tableBodyScrollY, setTableBodyScrollY] = useState(360);

  useLayoutEffect(() => {
    const el = tableScrollBoxRef.current;
    if (!el) return;
    const TABLE_HEAD_AND_PAGER_RESERVE = 118;

    const update = () => {
      const { height } = el.getBoundingClientRect();
      setTableBodyScrollY(Math.max(160, Math.floor(height - TABLE_HEAD_AND_PAGER_RESERVE)));
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { data: sessions, isLoading, error } = useQuery({
    queryKey: ['sessions', currentBotId],
    queryFn: () => api.listSessions(currentBotId),
  });

  const deleteMutation = useMutation({
    mutationFn: (key: string) => api.deleteSession(key, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('sessions.deleted') });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
      setSelectedRowKeys([]);
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const createMutation = useMutation({
    mutationFn: (key?: string) => api.createSession(key, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('sessions.created') });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return t('common.unknown');
    const date = new Date(dateStr);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return t('common.minutesAgo', { count: minutes });
    if (hours < 24) return t('common.hoursAgo', { count: hours });
    if (days < 7) return t('common.daysAgo', { count: days });
    return date.toLocaleDateString();
  };

  const processedSessions = sessions
    ?.filter((session) => {
      const search = searchQuery.toLowerCase();
      return (
        session.key.toLowerCase().includes(search) ||
        (session.title?.toLowerCase().includes(search) ?? false) ||
        (session.last_message?.toLowerCase().includes(search) ?? false)
      );
    })
    .sort((a, b) => {
      switch (sortBy) {
        case 'updated':
          return (
            new Date(b.updated_at || 0).getTime() - new Date(a.updated_at || 0).getTime()
          );
        case 'created':
          return (
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
          );
        case 'messages':
          return b.message_count - a.message_count;
      }
    });

  const handleBatchDelete = () => {
    selectedRowKeys.forEach((key) => deleteMutation.mutate(String(key)));
  };

  const columns: ColumnsType<SessionInfo> = [
    {
      title: t('sessions.colSession'),
      key: 'session',
      ellipsis: true,
      render: (_, session) => {
        const { channel, idPart } = parseSessionChannel(session.key);
        const linkLabel = session.title || (channel ? idPart : session.key);
        return (
          <div className="flex min-w-0 max-w-xl flex-col gap-1.5 py-0.5">
            <div className="flex min-w-0 items-start gap-2">
              {channel ? (
                <Tag
                  color={CHANNEL_TAG_COLOR[channel] ?? 'default'}
                  className="m-0 shrink-0 border-0 font-medium"
                >
                  {channel}
                </Tag>
              ) : null}
              <Tooltip title={session.key}>
                <Link
                  to={`/chat/${encodeURIComponent(session.key)}`}
                  className="min-w-0 font-medium text-gray-900 hover:text-blue-600 dark:text-gray-100 dark:hover:text-blue-400"
                >
                  <span className="block truncate">{linkLabel}</span>
                </Link>
              </Tooltip>
            </div>
            {session.last_message ? (
              <p className="truncate pl-0.5 text-xs leading-snug text-gray-500 dark:text-gray-400">
                {session.last_message}
              </p>
            ) : null}
          </div>
        );
      },
    },
    {
      title: t('sessions.colMessages'),
      dataIndex: 'message_count',
      key: 'message_count',
      width: 108,
      align: 'center',
      render: (count: number) => (
        <span className="inline-flex min-w-[2.5rem] items-center justify-center rounded-md bg-gray-100 px-2 py-0.5 text-sm font-medium tabular-nums text-gray-800 dark:bg-gray-700/80 dark:text-gray-100">
          <MessageOutlined className="mr-1 text-xs opacity-70" />
          {count}
        </span>
      ),
      sorter: (a, b) => a.message_count - b.message_count,
    },
    {
      title: t('sessions.colLastUpdated'),
      key: 'updated_at',
      width: 156,
      align: 'right',
      render: (_, session) => (
        <span className="inline-flex items-center justify-end gap-1.5 whitespace-nowrap text-sm text-gray-600 dark:text-gray-300">
          <ClockCircleOutlined className="text-gray-400 dark:text-gray-500" />
          {formatDate(session.updated_at || session.created_at)}
        </span>
      ),
      sorter: (a, b) =>
        new Date(a.updated_at || 0).getTime() - new Date(b.updated_at || 0).getTime(),
    },
    {
      title: t('sessions.colActions'),
      key: 'actions',
      width: 72,
      align: 'center',
      fixed: 'right',
      render: (_, session) => (
        <Popconfirm
          title={t('sessions.deleteTitle')}
          description={t('sessions.deleteDesc', { name: session.title || session.key })}
          onConfirm={() => deleteMutation.mutate(session.key)}
          okText={t('common.delete')}
          cancelText={t('common.cancel')}
          okButtonProps={{ danger: true }}
        >
          <Tooltip title={t('common.delete')}>
            <Button
              type="text"
              danger
              icon={<DeleteOutlined />}
              size="small"
              className="text-gray-500 hover:text-red-500 dark:text-gray-400"
            />
          </Tooltip>
        </Popconfirm>
      ),
    },
  ];

  const expandedRowRender = (session: SessionInfo) => (
    <div className="border-t border-gray-100 bg-gray-50/90 px-4 py-3 dark:border-gray-700 dark:bg-gray-900/40">
      <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 4 }} className="mb-0">
        <Descriptions.Item label={t('sessions.expandKey')}>
          <Text code copyable className="text-xs">
            {session.key}
          </Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.expandCreated')}>
          {session.created_at ? new Date(session.created_at).toLocaleString() : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.expandUpdated')}>
          {session.updated_at ? new Date(session.updated_at).toLocaleString() : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.expandMessages')}>{session.message_count}</Descriptions.Item>
      </Descriptions>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('sessions.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">{t('sessions.subtitle')}</p>
        </div>
        <Space>
          {selectedRowKeys.length > 0 && (
            <Popconfirm
              title={t('sessions.batchTitle')}
              description={t('sessions.batchDesc', { count: selectedRowKeys.length })}
              onConfirm={handleBatchDelete}
              okText={t('sessions.batchOk')}
              cancelText={t('common.cancel')}
              okButtonProps={{ danger: true }}
            >
              <Button danger icon={<DeleteOutlined />}>
                {t('sessions.batchBtn', { count: selectedRowKeys.length })}
              </Button>
            </Popconfirm>
          )}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            loading={createMutation.isPending}
            onClick={() => createMutation.mutate(undefined)}
          >
            {t('sessions.newSession')}
          </Button>
        </Space>
      </div>

      <Card
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35"
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } }}
      >
        <div className="flex shrink-0 flex-col gap-3 border-b border-gray-100 px-4 py-3 dark:border-gray-700 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <Input.Search
            placeholder={t('sessions.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onSearch={setSearchQuery}
            allowClear
            className="max-w-full sm:max-w-[min(100%,320px)]"
          />
          <Segmented
            className="activity-seg-align w-full sm:w-auto"
            value={sortBy}
            onChange={(val) => setSortBy(val as typeof sortBy)}
            options={[
              { value: 'updated', label: t('sessions.sortByTime'), icon: <ClockCircleOutlined /> },
              { value: 'messages', label: t('sessions.sortByMessages'), icon: <MessageOutlined /> },
            ]}
          />
        </div>

        <div ref={tableScrollBoxRef} className="min-h-0 min-w-0 flex-1">
          <Table<SessionInfo>
            className="sessions-page-table [&_.ant-table-thead>tr>th]:bg-gray-50/80 [&_.ant-table-thead>tr>th]:font-semibold dark:[&_.ant-table-thead>tr>th]:bg-gray-900/50"
            dataSource={processedSessions}
            columns={columns}
            rowKey="key"
            loading={isLoading}
            rowSelection={{
              selectedRowKeys,
              onChange: setSelectedRowKeys,
            }}
            expandable={{
              expandedRowRender,
              expandRowByClick: false,
            }}
            scroll={{ x: 820, y: tableBodyScrollY }}
          locale={{
            emptyText: error ? (
              <div className="text-red-500">{t('sessions.loadError', { error: String(error) })}</div>
            ) : (
              <Space direction="vertical" className="py-8">
                <MessageOutlined className="text-4xl text-gray-300 dark:text-gray-600" />
                <span className="text-gray-600 dark:text-gray-400">{t('sessions.empty')}</span>
                <Button
                  type="link"
                  size="small"
                  onClick={() => createMutation.mutate(undefined)}
                >
                  {t('sessions.emptyCreate')}
                </Button>
              </Space>
            ),
          }}
            pagination={{
              pageSize: 20,
              showSizeChanger: true,
              showTotal: (total) => t('sessions.paginationTotal', { total }),
              className:
                'shrink-0 px-4 py-3 mb-0 border-t border-gray-100 dark:border-gray-700 [&_.ant-pagination]:flex-wrap',
            }}
            size="middle"
          />
        </div>
      </Card>
    </div>
  );
}
