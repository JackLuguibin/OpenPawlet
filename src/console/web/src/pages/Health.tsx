import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Tag,
  Spin,
  Alert,
  Button,
  Typography,
  Empty,
} from 'antd';
import { ReloadOutlined, CheckCircleOutlined, ExclamationCircleOutlined, InfoCircleOutlined } from '@ant-design/icons';
import * as api from '../api/client';
import { useAppStore } from '../store';
import type { HealthIssue } from '../api/types';

const { Text } = Typography;

function IssueIcon({ severity }: { severity: string }) {
  if (severity === 'critical') return <ExclamationCircleOutlined className="text-red-500" />;
  if (severity === 'warning') return <ExclamationCircleOutlined className="text-amber-500" />;
  return <InfoCircleOutlined className="text-blue-500" />;
}

export default function Health() {
  const { t } = useTranslation();
  const { currentBotId } = useAppStore();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['health-audit', currentBotId],
    queryFn: () => api.getHealthAudit(currentBotId),
  });

  const issues = data?.issues ?? [];

  if (isLoading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-0 flex-1 flex-col p-6">
        <Alert type="error" message={t('health.loadFailed')} description={String(error)} showIcon />
      </div>
    );
  }

  const criticalCount = issues.filter((i) => i.severity === 'critical').length;
  const warningCount = issues.filter((i) => i.severity === 'warning').length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 p-6">
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            {t('health.title')}
          </h1>
          <p className="text-sm text-gray-500 mt-1">
            {t('health.subtitle')}
          </p>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => refetch()} />
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto">
      {issues.length === 0 ? (
        <Card
          className="flex min-h-0 flex-1 flex-col [&_.ant-card-body]:flex [&_.ant-card-body]:min-h-0 [&_.ant-card-body]:flex-1 [&_.ant-card-body]:flex-col [&_.ant-card-body]:items-center [&_.ant-card-body]:justify-center"
        >
          <Empty
            image={<CheckCircleOutlined style={{ fontSize: 64, color: '#22c55e' }} />}
            description={t('health.allGood')}
          />
        </Card>
      ) : (
        <>
          <Card size="small">
            <div className="flex items-center gap-4">
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

          <Card
            title={t('health.resultTitle')}
            size="small"
          >
            <div className="divide-y divide-gray-100 dark:divide-gray-700">
              {issues.map((issue: HealthIssue) => (
                <div key={issue.path ?? issue.message} className="flex items-center gap-3 py-3 first:pt-0 last:pb-0">
                  <IssueIcon severity={issue.severity} />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium">{issue.message}</p>
                    {issue.path && (
                      <Text type="secondary" className="text-xs">
                        {issue.path}
                      </Text>
                    )}
                  </div>
                  <Tag
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
    </div>
  );
}
