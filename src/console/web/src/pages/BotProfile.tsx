import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Spin, Empty, Card, Select, Button, Input } from 'antd';
import { EditOutlined, SaveOutlined, CloseOutlined } from '@ant-design/icons';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import type { BotFilesResponse } from '../api/types';

type TabKey = keyof BotFilesResponse;

const TABS: { key: TabKey; label: string }[] = [
  { key: 'soul', label: 'SOUL' },
  { key: 'user', label: 'USER' },
  { key: 'heartbeat', label: 'HEARTBEAT' },
  { key: 'tools', label: 'TOOLS' },
  { key: 'agents', label: 'AGENTS' },
];

const PROSE_CLASS = `
  prose prose-slate dark:prose-invert max-w-none
  prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-gray-900 dark:prose-headings:text-gray-100
  prose-h2:text-lg prose-h2:mt-8 prose-h2:mb-4 prose-h2:pb-2 prose-h2:border-b prose-h2:border-gray-200 dark:prose-h2:border-gray-600
  prose-h3:text-base prose-h3:mt-6 prose-h3:mb-3
  prose-p:leading-relaxed prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-p:my-2
  prose-li:marker:text-primary-500 prose-ul:my-3 prose-ol:my-3
  prose-strong:text-gray-900 dark:prose-strong:text-gray-100
  prose-hr:my-8 prose-hr:border-gray-200 dark:prose-hr:border-gray-600
  prose-a:text-primary-600 dark:prose-a:text-primary-400 prose-a:no-underline hover:prose-a:underline
`;

export default function BotProfile() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { currentBotId, setCurrentBotId, addToast } = useAppStore();
  const [activeTab, setActiveTab] = useState<TabKey>('soul');
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState('');

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

  const { data: botFiles, isLoading, error } = useQuery({
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
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
          {bots && bots.length > 1 && (
            <Select
              value={currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id}
              onChange={setCurrentBotId}
              options={bots.map((b) => ({ label: b.name, value: b.id }))}
              className="w-40"
            />
          )}
          {!editMode ? (
            <Button icon={<EditOutlined />} onClick={startEdit}>
              Edit
            </Button>
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

      <div className="flex flex-wrap gap-1 p-1 rounded-xl bg-gray-100/80 dark:bg-gray-800/50 border border-gray-200/60 dark:border-gray-700/50 w-fit shrink-0 mt-4 mb-3">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => {
              setActiveTab(key);
              setEditMode(false);
            }}
            className={`px-5 py-2.5 rounded-lg text-sm font-medium transition-all duration-200 ${
              activeTab === key
                ? 'bg-white dark:bg-gray-700/80 text-gray-900 dark:text-gray-100 shadow-sm'
                : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

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
              <div className="flex gap-2 shrink-0">
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
              </div>
            </div>
          ) : activeContent ? (
            <div className="max-w-3xl">
              <div className={PROSE_CLASS}>
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
    </div>
  );
}
