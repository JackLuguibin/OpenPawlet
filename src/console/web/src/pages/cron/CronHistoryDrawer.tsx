import { useMemo } from 'react';
import {
  Drawer,
  Empty,
  Tag,
  Space,
  Typography,
  Statistic,
  Row,
  Col,
  Spin,
  Tooltip,
  Collapse,
} from 'antd';
import {
  RobotOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  ApiOutlined,
  SendOutlined,
} from '@ant-design/icons';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import * as api from '../../api/client';
import type { CronHistoryRun, CronJob } from '../../api/types';
import { formatAgentLocaleString } from '../../utils/agentDatetime';

interface CronHistoryDrawerProps {
  open: boolean;
  job: CronJob | null;
  botId: string | null;
  agentTz: string;
  locale: string;
  agentNameById?: Map<string, string>;
  onClose: () => void;
}

const { Text, Paragraph } = Typography;

export function CronHistoryDrawer(props: CronHistoryDrawerProps) {
  const { open, job, botId, agentTz, locale, agentNameById, onClose } = props;
  const { t } = useTranslation();

  const { data: historyMap, isLoading } = useQuery<Record<string, CronHistoryRun[]>>({
    queryKey: ['cron-history', botId, job?.id],
    queryFn: () =>
      job
        ? api.getCronHistory(botId, job.id)
        : Promise.resolve<Record<string, CronHistoryRun[]>>({}),
    enabled: open && Boolean(job?.id),
    refetchOnWindowFocus: false,
  });

  const history = useMemo<CronHistoryRun[]>(() => {
    if (!job || !historyMap) return [];
    return historyMap[job.id] || [];
  }, [historyMap, job]);

  const stats = useMemo(() => {
    const total = history.length;
    const ok = history.filter((h) => h.status === 'ok').length;
    const failed = history.filter((h) => h.status !== 'ok').length;
    const avgMs = total
      ? history.reduce((acc, h) => acc + (h.duration_ms ?? 0), 0) / total
      : 0;
    return { total, ok, failed, avgMs };
  }, [history]);

  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={640}
      title={
        <Space>
          <span>{t('cron.historyDrawerTitle')}</span>
          {job && <Tag color="blue">{job.name}</Tag>}
        </Space>
      }
      destroyOnHidden
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spin />
        </div>
      ) : history.length === 0 ? (
        <Empty description={t('cron.historyEmpty')} />
      ) : (
        <>
          <Row gutter={12} className="mb-4">
            <Col span={6}>
              <Statistic title={t('cron.historyStatTotal')} value={stats.total} />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('cron.historyStatOk')}
                value={stats.ok}
                valueStyle={{ color: '#16a34a' }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('cron.historyStatFailed')}
                value={stats.failed}
                valueStyle={{ color: stats.failed > 0 ? '#dc2626' : undefined }}
              />
            </Col>
            <Col span={6}>
              <Statistic
                title={t('cron.historyStatAvg')}
                value={
                  stats.avgMs < 1000
                    ? `${Math.round(stats.avgMs)}ms`
                    : `${(stats.avgMs / 1000).toFixed(2)}s`
                }
              />
            </Col>
          </Row>
          <Collapse
            accordion
            size="small"
            items={[...history].reverse().map((h, i) => {
              const ok = h.status === 'ok';
              const agentName = h.agent_id
                ? agentNameById?.get(h.agent_id) ?? h.agent_id
                : t('cron.runDefaultAgent');
              return {
                key: `${h.run_at_ms}-${i}`,
                label: (
                  <div className="flex items-center justify-between gap-2 pr-2">
                    <Space size={6} wrap>
                      <Tag color={ok ? 'green' : 'red'} className="m-0">
                        {ok ? t('cron.runOk') : t('cron.runFail')}
                      </Tag>
                      <Text className="text-sm">
                        {formatAgentLocaleString(h.run_at_ms, agentTz, locale)}
                      </Text>
                      <Tooltip title={t('cron.runAgentTip')}>
                        <Tag icon={<RobotOutlined />} color="geekblue">
                          {agentName}
                        </Tag>
                      </Tooltip>
                    </Space>
                    <Text type="secondary" className="text-xs whitespace-nowrap">
                      {h.duration_ms < 1000
                        ? `${Math.round(h.duration_ms)}ms`
                        : `${(h.duration_ms / 1000).toFixed(2)}s`}
                    </Text>
                  </div>
                ),
                children: (
                  <div className="space-y-2 text-sm">
                    {h.error && (
                      <div className="rounded border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300">
                        <span className="font-medium">{t('cron.runErrorLabel')}: </span>
                        <span className="break-all">{h.error}</span>
                      </div>
                    )}
                    {(h.skills.length > 0 ||
                      h.tools.length > 0 ||
                      h.mcp_servers.length > 0) && (
                      <Space size={[4, 4]} wrap>
                        {h.skills.map((s) => (
                          <Tag key={`s-${s}`} icon={<ThunderboltOutlined />} color="purple">
                            {s}
                          </Tag>
                        ))}
                        {h.tools.map((s) => (
                          <Tag key={`t-${s}`} icon={<ToolOutlined />} color="cyan">
                            {s}
                          </Tag>
                        ))}
                        {h.mcp_servers.map((s) => (
                          <Tag key={`m-${s}`} icon={<ApiOutlined />} color="gold">
                            {s}
                          </Tag>
                        ))}
                      </Space>
                    )}
                    {(h.deliver || h.channel || h.to) && (
                      <Space size={6} wrap>
                        {h.deliver && (
                          <Tag icon={<SendOutlined />} color="blue">
                            {t('cron.runDeliver')}
                          </Tag>
                        )}
                        {h.channel && (
                          <Tag color="default">
                            {t('cron.runChannel')}: {h.channel}
                          </Tag>
                        )}
                        {h.to && (
                          <Tag color="default">
                            {t('cron.runTo')}: {h.to}
                          </Tag>
                        )}
                      </Space>
                    )}
                    {h.prompt ? (
                      <div>
                        <Text type="secondary" className="text-xs">
                          {t('cron.runPromptLabel')}
                        </Text>
                        <Paragraph
                          className="!mb-0 mt-1 whitespace-pre-wrap break-words rounded bg-gray-50 px-2 py-1.5 text-xs text-gray-700 dark:bg-gray-800/50 dark:text-gray-200"
                          ellipsis={{ rows: 6, expandable: true, symbol: t('common.expand') }}
                        >
                          {h.prompt}
                        </Paragraph>
                      </div>
                    ) : (
                      <Text type="secondary" className="text-xs">
                        {t('cron.runNoPrompt')}
                      </Text>
                    )}
                  </div>
                ),
              };
            })}
          />
        </>
      )}
    </Drawer>
  );
}

export default CronHistoryDrawer;
