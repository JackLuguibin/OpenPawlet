import { useState, useEffect, useMemo, type Key } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Tree,
  Spin,
  Button,
  Segmented,
  Empty,
  Modal,
} from 'antd';
import {
  ReloadOutlined,
  FolderOutlined,
  FileOutlined,
  SaveOutlined,
  CloseOutlined,
  DeleteOutlined,
} from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';
import { useBots } from '../hooks/useBots';
import { PageLayout } from '../components/PageLayout';
import { WorkspaceCodeEditor } from '../components/WorkspaceCodeEditor';
import { MARKDOWN_PROSE_CLASS } from '../utils/markdownProse';
import { formatQueryError } from '../utils/errors';

function buildTreeData(
  items: Array<{ name: string; path: string; is_dir: boolean; children?: unknown[] }>,
  basePath: string
): DataNode[] {
  return items.map((item) => {
    const fullPath = basePath ? `${basePath}/${item.name}` : item.name;
    const isLeaf = !item.is_dir;
    return {
      key: fullPath,
      title: item.name,
      icon: item.is_dir ? <FolderOutlined /> : <FileOutlined />,
      isLeaf,
      children: item.children
        ? buildTreeData(
            item.children as Array<{ name: string; path: string; is_dir: boolean; children?: unknown[] }>,
            fullPath
          )
        : undefined,
    };
  });
}

export default function Workspace() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const { currentBotId, addToast } = useAppStore();
  const { data: bots = [], isLoading: botsLoading, isFetched: botsFetched } = useBots();
  const waitingBot = botsFetched && bots.length > 0 && !currentBotId;
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<Key[]>([]);
  const [viewMode, setViewMode] = useState<'preview' | 'code' | 'edit'>('preview');
  const [editContent, setEditContent] = useState('');
  const [editMode, setEditMode] = useState(false);

  useEffect(() => {
    setExpandedKeys([]);
  }, [currentBotId]);

  const { data: filesData, isLoading: filesLoading } = useQuery({
    queryKey: ['workspace-files', currentBotId],
    queryFn: () => api.listWorkspaceFiles(undefined, 4, currentBotId),
    enabled: Boolean(currentBotId),
  });

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ['workspace-file', currentBotId, selectedFile],
    queryFn: () => api.getWorkspaceFile(selectedFile!, currentBotId),
    enabled: Boolean(currentBotId) && !!selectedFile,
  });

  const updateMutation = useMutation({
    mutationFn: ({ path, content }: { path: string; content: string }) =>
      api.updateWorkspaceFile(path, content, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('workspace.saved') });
      setViewMode('preview');
      setEditMode(false);
      queryClient.invalidateQueries({ queryKey: ['workspace-file', currentBotId, selectedFile!] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (path: string) => api.deleteWorkspaceFile(path, currentBotId),
    onSuccess: (_data, path) => {
      addToast({ type: 'success', message: t('workspace.deleted') });
      setSelectedFile(null);
      setEditMode(false);
      setViewMode('preview');
      queryClient.invalidateQueries({ queryKey: ['workspace-files', currentBotId] });
      queryClient.removeQueries({ queryKey: ['workspace-file', currentBotId, path] });
    },
    onError: (e) => addToast({ type: 'error', message: formatQueryError(e) }),
  });

  const confirmDeleteFile = () => {
    if (!selectedFile) return;
    const baseName = selectedFile.split('/').pop() ?? selectedFile;
    Modal.confirm({
      title: t('workspace.deleteConfirmTitle', { name: baseName }),
      content: t('workspace.deleteConfirmDesc'),
      okText: t('common.delete'),
      cancelText: t('common.cancel'),
      okType: 'danger',
      onOk: () => deleteMutation.mutateAsync(selectedFile),
    });
  };

  const treeData = useMemo(
    () => (filesData?.items ? buildTreeData(filesData.items, '') : []),
    [filesData?.items],
  );

  const handleSelect = (_selectedKeys: Key[], { node }: { node: DataNode }) => {
    const key = node.key as string;
    if (node.isLeaf) {
      setSelectedFile(key);
      setViewMode('preview');
      setEditMode(false);
    } else {
      setSelectedFile(null);
      setExpandedKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) {
          next.delete(key);
        } else {
          next.add(key);
        }
        return Array.from(next);
      });
    }
  };

  const startEdit = () => {
    setEditContent(fileData?.content ?? '');
    setEditMode(true);
    setViewMode('edit');
  };

  const cancelEdit = () => {
    setEditMode(false);
    setViewMode('preview');
  };

  const saveEdit = () => {
    if (selectedFile) {
      updateMutation.mutate({ path: selectedFile, content: editContent });
    }
  };

  const isMarkdown = selectedFile?.toLowerCase().endsWith('.md') ?? false;

  if (botsLoading || waitingBot) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  if (botsFetched && bots.length === 0) {
    return (
      <PageLayout variant="bleed">
        <Empty description={t('dashboard.botRequired')} />
      </PageLayout>
    );
  }

  if (Boolean(currentBotId) && filesLoading && !filesData) {
    return (
      <PageLayout variant="center">
        <Spin size="large" />
      </PageLayout>
    );
  }

  return (
    <PageLayout variant="bleed">
      <header className="shrink-0 rounded-2xl border border-gray-200/80 bg-gradient-to-b from-white to-gray-50/95 px-4 py-4 shadow-sm ring-1 ring-black/[0.03] dark:border-gray-700/60 dark:from-gray-800/90 dark:to-gray-900/50 dark:ring-white/[0.06] sm:px-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3 sm:gap-4">
            <div
              className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary-500/10 text-primary-600 dark:bg-primary-400/15 dark:text-primary-300"
              aria-hidden
            >
              <FolderOutlined className="text-lg" />
            </div>
            <div className="min-w-0">
              <h1 className="text-xl font-semibold tracking-tight text-gray-900 dark:text-gray-50 sm:text-2xl">
                {t('workspace.pageTitle')}
              </h1>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                {t('workspace.pageSubtitle')}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:justify-end md:border-l md:border-gray-200/80 md:pl-5 dark:md:border-gray-700/60">
            <Button
              type="default"
              shape="circle"
              icon={<ReloadOutlined />}
              title={t('workspace.refreshList')}
              aria-label={t('workspace.refreshList')}
              onClick={() => {
                if (!currentBotId) return;
                queryClient.invalidateQueries({ queryKey: ['workspace-files', currentBotId] });
                queryClient.invalidateQueries({ queryKey: ['workspace-file', currentBotId] });
              }}
            />
            {selectedFile && !editMode && (
              <Segmented
                value={viewMode}
                options={[
                  { label: t('workspace.viewPreview'), value: 'preview' },
                  { label: t('workspace.viewCode'), value: 'code' },
                  { label: t('workspace.viewEdit'), value: 'edit' },
                ]}
                onChange={(v) => {
                  const mode = v as 'preview' | 'code' | 'edit';
                  setViewMode(mode);
                  if (mode === 'edit') startEdit();
                }}
              />
            )}
            {selectedFile && editMode && (
              <>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={saveEdit}
                  loading={updateMutation.isPending}
                >
                  {t('common.save')}
                </Button>
                <Button icon={<CloseOutlined />} onClick={cancelEdit}>
                  {t('common.cancel')}
                </Button>
              </>
            )}
            {selectedFile && (
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={deleteMutation.isPending}
                onClick={confirmDeleteFile}
                title={t('workspace.deleteFile')}
                aria-label={t('workspace.deleteFile')}
              />
            )}
          </div>
        </div>
      </header>

      <div className="mt-5 flex min-h-0 min-w-0 flex-1 gap-6">
        <Card
          title={t('workspace.fileListTitle')}
          size="small"
          className="w-72 shrink-0 flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow overflow-hidden"
          styles={{ body: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '1rem' } }}
        >
          {treeData.length > 0 ? (
            <Tree
              showIcon
              treeData={treeData}
              blockNode
              expandedKeys={expandedKeys}
              onExpand={setExpandedKeys}
              selectedKeys={selectedFile ? [selectedFile] : []}
              onSelect={handleSelect}
            />
          ) : (
            <Empty description={t('workspace.emptyFiles')} className="py-8" />
          )}
        </Card>

        <Card
          className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow"
          styles={{
            body: {
              padding: '2rem 2.5rem',
              flex: 1,
              minHeight: 0,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            },
          }}
        >
          {!selectedFile ? (
            <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center">
              <Empty description={t('workspace.selectFileHint')} className="text-gray-500" />
            </div>
          ) : fileLoading ? (
            <div className="flex justify-center py-12">
              <Spin />
            </div>
          ) : editMode ? (
            <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)]">
              <WorkspaceCodeEditor
                value={editContent}
                onChange={setEditContent}
                filePath={selectedFile}
                placeholder={t('workspace.editPlaceholder')}
              />
            </div>
          ) : viewMode === 'preview' && isMarkdown ? (
            <div className="w-full">
              <div className={MARKDOWN_PROSE_CLASS}>
                <Markdown>{fileData?.content ?? ''}</Markdown>
              </div>
            </div>
          ) : viewMode === 'preview' && !isMarkdown ? (
            <pre className="text-sm overflow-auto max-h-full p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
              {fileData?.content ?? ''}
            </pre>
          ) : (
            <pre className="text-sm overflow-auto max-h-full p-4 bg-gray-50 dark:bg-gray-800 rounded-lg whitespace-pre-wrap">
              {fileData?.content ?? ''}
            </pre>
          )}
        </Card>
      </div>
    </PageLayout>
  );
}
