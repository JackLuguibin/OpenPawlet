import { useState, useEffect, type Key } from 'react';
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
import { PageLayout } from '../components/PageLayout';
import { WorkspaceCodeEditor } from '../components/WorkspaceCodeEditor';

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
  });

  const { data: fileData, isLoading: fileLoading } = useQuery({
    queryKey: ['workspace-file', currentBotId, selectedFile],
    queryFn: () => api.getWorkspaceFile(selectedFile!, currentBotId),
    enabled: !!selectedFile,
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
    onError: (e) => addToast({ type: 'error', message: String(e) }),
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
    onError: (e) => addToast({ type: 'error', message: String(e) }),
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

  const treeData = filesData?.items
    ? buildTreeData(filesData.items, '')
    : [];

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

  if (filesLoading && !filesData) {
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
          title="文件列表"
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
            <Empty description="暂无文件" className="py-8" />
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
              <Empty description="从左侧选择文件" className="text-gray-500" />
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
              <div className={PROSE_CLASS}>
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
