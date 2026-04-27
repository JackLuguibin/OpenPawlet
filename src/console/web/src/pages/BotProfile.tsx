import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card, Button, Input, Segmented } from 'antd';
import { EditOutlined, SaveOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import type { BotFilesResponse } from '../api/types';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';
import { formatQueryError, isNotFoundError } from '../utils/errors';

type TabKey = keyof BotFilesResponse;

/**
 * Persona / bootstrap file editor (SOUL, USER, HEARTBEAT, etc.).
 * Renders the inner layout only; used from the combined Memory & profile page.
 */
export function BotProfilePanel({ currentBotId }: { currentBotId: string | null }) {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { addToast } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabKey>('soul');
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');

  const tabs = useMemo(
    () => [
      { value: 'soul' as TabKey, label: t('botProfile.tabSoul') },
      { value: 'user' as TabKey, label: t('botProfile.tabUser') },
      { value: 'heartbeat' as TabKey, label: t('botProfile.tabHeartbeat') },
      { value: 'tools' as TabKey, label: t('botProfile.tabTools') },
      { value: 'agents' as TabKey, label: t('botProfile.tabAgents') },
    ],
    [t],
  );

  const activeTabLabel = tabs.find((x) => x.value === activeTab)?.label ?? activeTab;
  const activeFileLabel = `${activeTabLabel}.md`;

  const { data: botFiles, isLoading, isFetching, error } = useQuery({
    queryKey: ['bot-files', currentBotId],
    queryFn: () => api.getBotFiles(currentBotId),
    enabled: Boolean(currentBotId),
  });

  const updateFileMutation = useMutation({
    mutationFn: ({ key, content }: { key: TabKey; content: string }) =>
      api.updateBotFile(key, content, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('botProfile.saved') });
      setEditMode(false);
      if (currentBotId) {
        void queryClient.invalidateQueries({ queryKey: ['bot-files', currentBotId] });
      }
    },
    onError: (err) => {
      addToast({ type: 'error', message: formatQueryError(err) });
    },
  });

  const activeContent = botFiles?.[activeTab]?.trim() ?? '';

  const startEdit = () => {
    setEditContent(activeContent);
    setEditMode(true);
  };

  const cancelEdit = () => {
    setEditMode(false);
    setEditContent('');
  };

  const saveEdit = () => {
    updateFileMutation.mutate({ key: activeTab, content: editContent });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0">
      <div className="mb-2 flex min-w-0 flex-col gap-2 sm:mb-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="min-w-0 flex-1">
          <Segmented
            size="small"
            options={tabs}
            value={activeTab}
            onChange={(val) => {
              setActiveTab(val as TabKey);
              setEditMode(false);
            }}
            aria-label={t('botProfile.ariaTabs')}
          />
        </div>
        <div className="flex shrink-0 items-center justify-end gap-2">
          {!editMode ? (
            <>
              <Button
                type="default"
                shape="circle"
                size="small"
                icon={<ReloadOutlined />}
                title={t('botProfile.refreshBootstrap')}
                aria-label={t('botProfile.refreshBootstrap')}
                loading={isFetching && !isLoading}
                onClick={() => {
                  if (currentBotId) {
                    void queryClient.invalidateQueries({ queryKey: ['bot-files', currentBotId] });
                  }
                }}
              />
              <Button type="default" size="small" icon={<EditOutlined />} onClick={startEdit}>
                {t('common.edit')}
              </Button>
            </>
          ) : (
            <>
              <Button
                type="primary"
                size="small"
                icon={<SaveOutlined />}
                onClick={saveEdit}
                loading={updateFileMutation.isPending}
              >
                {t('common.save')}
              </Button>
              <Button size="small" icon={<CloseOutlined />} onClick={cancelEdit}>
                {t('common.cancel')}
              </Button>
            </>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-12">
          <Spin />
        </div>
      ) : error ? (
        <Empty
          description={
            <span className="text-red-500">
              {isNotFoundError(error) ? t('memory.workspaceNotFound') : formatQueryError(error)}
            </span>
          }
        />
      ) : (
        <Card
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {editMode ? (
            <div className="flex flex-col gap-4">
              <Input.TextArea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={24}
                className="font-mono text-sm"
                placeholder={t('botProfile.placeholderEdit', { file: activeFileLabel })}
              />
            </div>
          ) : activeContent ? (
            <div className="max-w-3xl">
              <div className={MARKDOWN_PROSE_CLASS}>
                <Markdown>{activeContent}</Markdown>
              </div>
            </div>
          ) : (
            <div className="flex flex-col flex-1 items-center justify-center min-h-[200px]">
              <Empty
                description={t('botProfile.emptyFile', { file: activeFileLabel })}
                className="text-gray-500"
              />
              <Button type="primary" icon={<EditOutlined />} onClick={startEdit} className="mt-4">
                {t('botProfile.createContent')}
              </Button>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
