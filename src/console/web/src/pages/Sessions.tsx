import { useState, useRef, useLayoutEffect, useEffect, useMemo } from 'react';
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
  Pagination,
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
import { PageLayout } from '../components/PageLayout';
import { formatQueryError } from '../utils/errors';
import { useAgentTimeZone } from '../hooks/useAgentTimeZone';
import { formatAgentLocaleDate, formatAgentLocaleString } from '../utils/agentDatetime';

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
  const { t, i18n } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId } = useAppStore();
  const agentTz = useAgentTimeZone();
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en-US';
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'created' | 'messages'>('updated');
  const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const tableScrollBoxRef = useRef<HTMLDivElement>(null);
  const [tableBodyScrollY, setTableBodyScrollY] = useState(360);

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
      addToast({ type: 'error', message: formatQueryError(error) });
    },
  });

  const createMutation = useMutation({
    mutationFn: (key?: string) => api.createSession(key, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('sessions.created') });
      queryClient.invalidateQueries({ queryKey: ['sessions'] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: formatQueryError(error) });
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
    return formatAgentLocaleDate(date, agentTz, locale);
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

  const sessionList = useMemo(() => processedSessions ?? [], [processedSessions]);
  const totalRows = sessionList.length;

  const pagedSessions = useMemo(() => {
    const start = (page - 1) * pageSize;
    return sessionList.slice(start, start + pageSize);
  }, [sessionList, page, pageSize]);

  useEffect(() => {
    setPage(1);
  }, [searchQuery, sortBy]);

  useEffect(() => {
    if (totalRows === 0) {
      if (page !== 1) setPage(1);
      return;
    }
    const maxPage = Math.max(1, Math.ceil(totalRows / pageSize));
    if (page > maxPage) setPage(maxPage);
  }, [totalRows, page, pageSize]);

  useLayoutEffect(() => {
    const el = tableScrollBoxRef.current;
    if (!el) return;

    const readHeaderBlockHeight = (root: Element): number => {
      const header = root.querySelector<HTMLElement>('.ant-table-header');
      if (header) {
        return header.getBoundingClientRect().height;
      }
      const sticky = root.querySelector<HTMLElement>('.ant-table-sticky-header');
      if (sticky) {
        return sticky.getBoundingClientRect().height;
      }
      const th = root.querySelector<HTMLElement>('.ant-table-thead');
      return th ? th.getBoundingClientRect().height : 64;
    };

    const update = () => {
      const boxH = el.clientHeight;
      if (boxH < 1) return;

      const headH = readHeaderBlockHeight(el);
      let y = Math.max(80, Math.floor(boxH - headH - 2));

      const tableRoot = el.querySelector<HTMLElement>('.ant-table');
      if (tableRoot) {
        const tableH = tableRoot.getBoundingClientRect().height;
        if (tableH > 8 && tableH < boxH - 0.5) {
          y = Math.max(80, y + Math.round(boxH - tableH));
        }
      }

      setTableBodyScrollY(y);
    };

    update();
    const ro = new ResizeObserver(() => update());
    ro.observe(el);
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => update());
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
      ro.disconnect();
    };
  }, [isLoading, pagedSessions.length, error, totalRows]);

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
          {session.created_at ? formatAgentLocaleString(session.created_at, agentTz, locale) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.expandUpdated')}>
          {session.updated_at ? formatAgentLocaleString(session.updated_at, agentTz, locale) : '-'}
        </Descriptions.Item>
        <Descriptions.Item label={t('sessions.expandMessages')}>{session.message_count}</Descriptions.Item>
      </Descriptions>
    </div>
  );

  return (
    <PageLayout className="min-h-0 flex-1 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-6 overflow-hidden">
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
        className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35 [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:overflow-hidden"
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

        <div className="flex h-0 min-h-0 w-full min-w-0 flex-1 flex-col">
          <div
            ref={tableScrollBoxRef}
            className="flex h-0 w-full min-w-0 min-h-0 flex-1 flex-col overflow-hidden [&_.ant-table-body]:!min-h-[var(--session-tbody-y,120px)]"
            style={
              {
                minHeight: 0,
                ['--session-tbody-y' as string]: `${tableBodyScrollY}px`,
              } as React.CSSProperties
            }
          >
            <Table<SessionInfo>
              style={{ display: 'flex', flex: 1, minHeight: 0, width: '100%', flexDirection: 'column' }}
              className="sessions-page-table flex min-h-0 w-full min-w-0 flex-1 flex-col [&_.ant-spin]:!flex [&_.ant-spin]:!h-full [&_.ant-spin]:!min-h-0 [&_.ant-spin]:!flex-1 [&_.ant-spin]:!flex-col [&_.ant-spin-section]:shrink-0 [&_.ant-spin-container]:!flex [&_.ant-spin-container]:!h-full [&_.ant-spin-container]:!min-h-0 [&_.ant-spin-container]:!flex-1 [&_.ant-spin-container]:!flex-col [&_.ant-table]:!h-full [&_.ant-table]:!min-h-0 [&_.ant-table]:min-w-0 [&_.ant-table-thead>tr>th]:bg-gray-50/80 [&_.ant-table-thead>tr>th]:font-semibold dark:[&_.ant-table-thead>tr>th]:bg-gray-900/50"
              dataSource={pagedSessions}
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
              pagination={false}
              locale={{
                emptyText: error ? (
                  <div className="text-red-500">
                    {t('sessions.loadError', { error: formatQueryError(error) })}
                  </div>
                ) : (
                  <Space orientation="vertical" className="py-8">
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
              size="middle"
            />
          </div>
          <div className="shrink-0 border-t border-gray-100 dark:border-gray-700">
            <Pagination
              size="small"
              className="m-0 flex w-full max-w-full justify-end px-4 py-3 [&_ul]:mb-0 [&_ul]:flex-wrap"
              current={page}
              pageSize={pageSize}
              total={totalRows}
              showSizeChanger
              showTotal={(n) => t('sessions.paginationTotal', { total: n })}
              onChange={(p, size) => {
                setPage(p);
                if (size != null) setPageSize(size);
              }}
            />
          </div>
        </div>
      </Card>
      </div>
    </PageLayout>
  );
}
