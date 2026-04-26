import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import {
  Card,
  Tag,
  Spin,
  Alert,
  Typography,
} from 'antd';
import { ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { ArrowRight, Heart, LineChart } from 'lucide-react';
import * as api from '../api/client';
import { formatQueryError } from '../utils/errors';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import type { HealthIssue } from '../api/types';

const { Text, Title } = Typography;

function IssueIcon({ severity }: { severity: string }) {
  if (severity === 'critical') return <ExclamationCircleOutlined className="text-red-500" />;
  if (severity === 'warning') return <ExclamationCircleOutlined className="text-amber-500" />;
  return <InfoCircleOutlined className="text-blue-500" />;
}

function StatRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-gray-100 py-2.5 last:border-b-0 dark:border-gray-700/80">
      <Text type="secondary" className="text-xs shrink-0">
        {label}
      </Text>
      <div className="min-w-0 text-right text-sm">{children}</div>
    </div>
  );
}

export default function Health({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();

  const { data, isLoading, error } = useQuery({
    queryKey: ['health-audit', currentBotId],
    queryFn: () => api.getHealthAudit(currentBotId),
  });

  const {
    data: obsData,
    isLoading: obsLoading,
    error: obsError,
  } = useQuery({
    queryKey: ['observability', currentBotId],
    queryFn: () => api.getObservability(currentBotId),
  });

  if (isLoading) {
    return (
      <PageLayout variant="center" embedded={embedded}>
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (error) {
    return (
      <PageLayout variant="bleed" embedded={embedded}>
        <Alert type="error" title={t('health.loadFailed')} description={formatQueryError(error)} showIcon />
      </PageLayout>
    );
  }

  const issues = data?.issues ?? [];
  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return (
    <PageLayout embedded={embedded}>
      <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-emerald-100 dark:bg-emerald-900/40">
            <Heart className="h-5 w-5 text-emerald-600 dark:text-emerald-300" />
          </div>
          <div>
            <Title level={1} className="!m-0 !text-2xl !font-bold">
              {t('health.title')}
            </Title>
            <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-gray-400">{t('health.subtitle')}</p>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pt-1">
        {obsError && (
          <Alert
            type="warning"
            title={t('health.observabilityFailed')}
            description={formatQueryError(obsError)}
            showIcon
            className="shrink-0"
          />
        )}
        <Card
          size="small"
          loading={obsLoading}
          className="shrink-0 overflow-hidden shadow-sm dark:border-gray-700"
        >
          {obsData && (
            <div className="flex flex-col gap-5">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-md border border-gray-200/90 bg-gray-50/80 p-4 dark:border-gray-700 dark:bg-gray-800/40">
                  <Text strong className="mb-1 block text-sm text-gray-800 dark:text-gray-100">
                    {t('health.consoleApi')}
                  </Text>
                  <div className="mt-2">
                    <StatRow label={t('health.labelStatus')}>
                      <Tag color="success">{obsData.console.status}</Tag>
                    </StatRow>
                    <StatRow label={t('health.labelVersion')}>
                      <Text className="font-mono text-xs">{obsData.console.version}</Text>
                    </StatRow>
                  </div>
                </div>
                <div className="rounded-md border border-gray-200/90 bg-gray-50/80 p-4 dark:border-gray-700 dark:bg-gray-800/40">
                  <Text strong className="mb-1 block text-sm text-gray-800 dark:text-gray-100">
                    {t('health.nanobotGateway')}
                  </Text>
                  <div className="mt-2">
                    <StatRow label={t('health.labelStatus')}>
                      <Tag color={obsData.nanobot_gateway.ok ? 'success' : 'error'}>
                        {obsData.nanobot_gateway.ok ? t('health.reachable') : t('health.unreachable')}
                      </Tag>
                    </StatRow>
                    <StatRow label={t('health.probeEndpoint')}>
                      <Text code copyable className="!text-xs break-all">
                        {obsData.nanobot_gateway.endpoint}
                      </Text>
                    </StatRow>
                    {obsData.nanobot_gateway.version != null && (
                      <StatRow label={t('health.labelVersion')}>
                        <Text className="font-mono text-xs">{obsData.nanobot_gateway.version}</Text>
                      </StatRow>
                    )}
                    {obsData.nanobot_gateway.uptime_s != null && (
                      <StatRow label={t('health.uptimeSeconds')}>
                        {`${obsData.nanobot_gateway.uptime_s.toFixed(1)} s`}
                      </StatRow>
                    )}
                    {obsData.nanobot_gateway.error && (
                      <StatRow label={t('health.probeError')}>
                        <Text type="danger" className="break-words text-sm">
                          {obsData.nanobot_gateway.error}
                        </Text>
                      </StatRow>
                    )}
                  </div>
                </div>
              </div>

              <Link
                to="/observability?section=trace"
                className="group flex items-center justify-between gap-3 rounded-md border border-violet-200/90 bg-violet-50/60 px-4 py-3 transition-colors hover:border-violet-300 hover:bg-violet-100/70 dark:border-violet-500/25 dark:bg-violet-950/35 dark:hover:border-violet-400/40 dark:hover:bg-violet-900/40"
              >
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium text-violet-800 dark:text-violet-200">
                  <LineChart className="h-4 w-4 shrink-0" />
                  <span className="truncate">{t('health.linkAgentObservability')}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-violet-400 transition-transform group-hover:translate-x-0.5 dark:text-violet-400" />
              </Link>
              <p className="-mt-2 text-xs text-gray-500 dark:text-gray-400">{t('health.linkAgentObservabilityHint')}</p>
            </div>
          )}
        </Card>

        {issues.length > 0 && (
          <>
            <Card size="small" className="shrink-0 shadow-sm dark:border-gray-700">
              <div className="flex flex-wrap items-center gap-2">
                {criticalCount > 0 && (
                  <Tag color="red">{t('health.tagCritical', { count: criticalCount })}</Tag>
                )}
                {warningCount > 0 && (
                  <Tag color="orange">{t('health.tagWarning', { count: warningCount })}</Tag>
                )}
                {issues.length - criticalCount - warningCount > 0 && (
                  <Tag color="blue">
                    {t('health.tagInfo', { count: issues.length - criticalCount - warningCount })}
                  </Tag>
                )}
              </div>
            </Card>

            <Card title={t('health.resultTitle')} size="small" className="min-h-0 shadow-sm dark:border-gray-700">
              <div className="divide-y divide-gray-100 dark:divide-gray-700">
                {issues.map((issue: HealthIssue) => (
                  <div
                    key={issue.path ?? issue.message}
                    className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0"
                  >
                    <span className="mt-0.5 shrink-0">
                      <IssueIcon severity={issue.severity} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-gray-900 dark:text-gray-100">{issue.message}</p>
                      {issue.path && (
                        <Text type="secondary" className="mt-0.5 block text-xs">
                          {issue.path}
                        </Text>
                      )}
                    </div>
                    <Tag
                      className="shrink-0"
                      color={
                        issue.severity === 'critical'
                          ? 'red'
                          : issue.severity === 'warning'
                            ? 'orange'
                            : 'blue'
                      }
                    >
                      {issue.severity === 'critical'
                        ? t('health.severityCritical')
                        : issue.severity === 'warning'
                          ? t('health.severityWarning')
                          : t('health.severityInfo')}
                    </Tag>
                  </div>
                ))}
              </div>
            </Card>
          </>
        )}
      </div>
    </PageLayout>
  );
}
