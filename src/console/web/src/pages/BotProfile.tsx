import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card, Button, Input } from 'antd';
import { EditOutlined, SaveOutlined, CloseOutlined, ReloadOutlined } from '@ant-design/icons';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { SegmentedTabs } from '../components/SegmentedTabs';
import type { BotFilesResponse } from '../api/types';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';

type TabKey = keyof BotFilesResponse;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'soul', label: 'SOUL' },
  { key: 'user', label: 'USER' },
  { key: 'heartbeat', label: 'HEARTBEAT' },
  { key: 'tools', label: 'TOOLS' },
  { key: 'agents', label: 'AGENTS' },
];

export default function BotProfile() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { currentBotId, addToast } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabKey>('soul');
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');

  const { data: botFiles, isLoading, isFetching, error } = useQuery({
    queryKey: ['bot-files', currentBotId],
    queryFn: () => api.getBotFiles(currentBotId),
  });

  const updateFileMutation = useMutation({
    mutationFn: ({ key, content }: { key: TabKey; content: string }) =>
      api.updateBotFile(key, content, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('botProfile.saved') });
      setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ['bot-files'] });
    },
    onError: (err) => {
      addToast({ type: 'error', message: String(err) });
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
    <PageLayout variant="bleed">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            Profile
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            SOUL, USER, HEARTBEAT, TOOLS, AGENTS and other bootstrap files
          </p>
        </div>
        <div className="flex items-center gap-2">
          {!editMode ? (
            <>
              <Button
                type="default"
                shape="circle"
                icon={<ReloadOutlined />}
                title={t('botProfile.refreshBootstrap')}
                aria-label={t('botProfile.refreshBootstrap')}
                loading={isFetching && !isLoading}
                onClick={() => {
                  void queryClient.invalidateQueries({ queryKey: ['bot-files', currentBotId] });
                }}
              />
              <Button icon={<EditOutlined />} onClick={startEdit}>
                Edit
              </Button>
            </>
          ) : (
            <>
              <Button
                type="primary"
                icon={<SaveOutlined />}
                onClick={saveEdit}
                loading={updateFileMutation.isPending}
              >
                Save
              </Button>
              <Button icon={<CloseOutlined />} onClick={cancelEdit}>
                Cancel
              </Button>
            </>
          )}
        </div>
      </div>

      <SegmentedTabs
        ariaLabel="Bootstrap files"
        tabs={TABS}
        value={activeTab}
        onChange={(key) => {
          setActiveTab(key);
          setEditMode(false);
        }}
      />

      {isLoading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center py-12">
          <Spin />
        </div>
      ) : error ? (
        <Empty
          description={
            <span className="text-red-500">
              {String(error).includes('404') ? 'Workspace not found' : String(error)}
            </span>
          }
        />
      ) : (
        <Card
          className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow"
          styles={{ body: { padding: '2rem 2.5rem', flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {editMode ? (
            <div className="flex flex-col gap-4">
              <Input.TextArea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={24}
                className="font-mono text-sm"
                placeholder={`Write ${TABS.find((t) => t.key === activeTab)?.label ?? activeTab}.md content...`}
              />
            </div>
          ) : activeContent ? (
            <div className="max-w-3xl">
              <div className={MARKDOWN_PROSE_CLASS}>
                <Markdown>{activeContent}</Markdown>
              </div>
            </div>
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-[200px]">
              <Empty
                description={`No content in ${TABS.find((t) => t.key === activeTab)?.label ?? activeTab}.md yet`}
                className="text-gray-500"
              />
              <Button type="primary" icon={<EditOutlined />} onClick={startEdit} className="mt-4">
                Create content
              </Button>
            </div>
          )}
        </Card>
      )}
    </PageLayout>
  );
}
