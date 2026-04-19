import { useState, useEffect } from 'react';
import { Collapse, Tag, Typography, Spin, Button } from 'antd';
import { useTranslation } from 'react-i18next';
import {
  CheckCircleOutlined,
  LoadingOutlined,
  CloseCircleOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  MinusOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import { Markdown } from './Markdown';

const { Panel } = Collapse;
const { Text } = Typography;

export interface SubagentTask {
  id: string;
  label: string;
  task?: string;
  status: 'running' | 'success' | 'error';
  result?: string;
  content?: string;
}

interface SubagentPanelProps {
  tasks: SubagentTask[];
  collapsed?: boolean;
  onCollapse?: () => void;
}

export function SubagentPanel({ tasks, collapsed = false, onCollapse }: SubagentPanelProps) {
  const { t } = useTranslation();
  const [panelCollapsed, setPanelCollapsed] = useState(collapsed);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);

  useEffect(() => {
    setPanelCollapsed(collapsed);
  }, [collapsed]);

  useEffect(() => {
    // Auto-collapse completed tasks, keep running ones expanded
    const runningKeys = tasks.filter(t => t.status === 'running').map(t => t.id);
    setExpandedKeys(runningKeys);
  }, [tasks]);

  const runningCount = tasks.filter(t => t.status === 'running').length;
  const successCount = tasks.filter(t => t.status === 'success').length;
  const errorCount = tasks.filter(t => t.status === 'error').length;
  const completedCount = successCount + errorCount;

  const togglePanel = () => {
    setPanelCollapsed(!panelCollapsed);
    onCollapse?.();
  };

  const getStatusTag = (status: SubagentTask['status']) => {
    switch (status) {
      case 'running':
        return (
          <Tag icon={<LoadingOutlined />} color="processing">
            {t('subagent.running')}
          </Tag>
        );
      case 'success':
        return (
          <Tag icon={<CheckCircleOutlined />} color="success">
            {t('subagent.completed')}
          </Tag>
        );
      case 'error':
        return (
          <Tag icon={<CloseCircleOutlined />} color="error">
            {t('subagent.failed')}
          </Tag>
        );
    }
  };

  const getStatusIcon = (status: SubagentTask['status']) => {
    switch (status) {
      case 'running':
        return <LoadingOutlined spin />;
      case 'success':
        return <CheckCircleOutlined className="text-green-500" />;
      case 'error':
        return <CloseCircleOutlined className="text-red-500" />;
    }
  };

  if (tasks.length === 0) {
    return null;
  }

  const renderSummary = () => (
    <div className="flex flex-col items-center justify-center gap-2 text-xs text-gray-400">
      {runningCount > 0 && (
        <div className="flex items-center gap-1">
          <LoadingOutlined spin className="text-blue-400" />
          {t('subagent.runningCount', { count: runningCount })}
        </div>
      )}
      {successCount > 0 && (
        <div className="flex items-center gap-1">
          <CheckCircleOutlined className="text-green-400" />
          {t('subagent.successCount', { count: successCount })}
        </div>
      )}
      {errorCount > 0 && (
        <div className="flex items-center gap-1">
          <CloseCircleOutlined className="text-red-400" />
          {t('subagent.errorCount', { count: errorCount })}
        </div>
      )}
      {runningCount === 0 && completedCount === 0 && (
        <span className="text-gray-500">{t('subagent.noTasks')}</span>
      )}
    </div>
  );

  return (
    <div className={`${panelCollapsed ? 'w-12' : 'w-80'} h-full bg-white/50 dark:bg-gray-800/50 backdrop-blur-sm border-l border-gray-200/50 dark:border-gray-700/50 flex flex-col transition-all duration-200`}>
      {/* Header */}
      <div className="px-4 py-3 border-b border-gray-200/50 dark:border-gray-700/50 flex items-center justify-between">
        {!panelCollapsed && (
          <div className="flex items-center gap-2">
            <Text strong className="text-sm">{t('subagent.panelTitle')}</Text>
            {runningCount > 0 && (
              <Spin indicator={<LoadingOutlined spin />} size="small" />
            )}
          </div>
        )}
        <Button
          type="text"
          size="small"
          icon={panelCollapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          onClick={togglePanel}
          className="ml-auto"
        />
      </div>

      {panelCollapsed ? (
        <div className="flex-1 flex items-center justify-center px-2">
          {renderSummary()}
        </div>
      ) : (
        <>
          {/* Stats */}
          <div className="px-4 py-2 text-xs text-gray-500 flex items-center gap-2">
            {runningCount > 0 && (
              <Tag color="processing" icon={<LoadingOutlined spin />}>
                {t('subagent.runningCount', { count: runningCount })}
              </Tag>
            )}
            {completedCount > 0 && (
              <Tag color="default">{t('subagent.completedTag', { count: completedCount })}</Tag>
            )}
          </div>

          {/* Task List */}
          <div className="flex-1 overflow-y-auto p-3">
            <Collapse
              ghost
              activeKey={expandedKeys}
              onChange={(keys) => setExpandedKeys(keys as string[])}
            >
              {tasks.map((task) => (
                <Panel
                  key={task.id}
                  header={
                    <div className="flex items-center justify-between w-full pr-2">
                      <div className="flex items-center gap-2 min-w-0">
                        {getStatusIcon(task.status)}
                        <Text ellipsis className="text-sm">
                          {task.label}
                        </Text>
                      </div>
                      {getStatusTag(task.status)}
                    </div>
                  }
                  extra={
                    <Button
                      type="text"
                      size="small"
                      icon={expandedKeys.includes(task.id) ? <MinusOutlined /> : <PlusOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        setExpandedKeys(prev =>
                          prev.includes(task.id)
                            ? prev.filter(k => k !== task.id)
                            : [...prev, task.id]
                        );
                      }}
                    />
                  }
                >
                  {/* Task Details */}
                  <div className="space-y-3 text-sm">
                    {task.task && (
                      <div>
                        <Text type="secondary" className="text-xs block mb-1">
                          {t('subagent.taskDesc')}
                        </Text>
                        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-2 text-xs line-clamp-3">
                          <Text>{task.task}</Text>
                        </div>
                      </div>
                    )}

                    {/* Result */}
                    {task.status !== 'running' && task.result && (
                      <div>
                        <Text type="secondary" className="text-xs block mb-1">
                          {t('subagent.taskResult')}
                        </Text>
                        <div className="bg-gray-50 dark:bg-gray-900 rounded-lg p-2 text-xs max-h-60 overflow-y-auto">
                          <Markdown>{task.result}</Markdown>
                        </div>
                      </div>
                    )}

                    {/* Running state */}
                    {task.status === 'running' && (
                      <div className="flex items-center gap-2 text-gray-500">
                        <Spin size="small" />
                        <Text type="secondary">{t('subagent.waiting')}</Text>
                      </div>
                    )}
                  </div>
                </Panel>
              ))}
            </Collapse>
          </div>
        </>
      )}
    </div>
  );
}

export default SubagentPanel;
