import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  Card,
  Tree,
  Spin,
  Button,
  Input,
  Segmented,
  Empty,
} from 'antd';
import {
  ReloadOutlined,
  FolderOutlined,
  FileOutlined,
  SaveOutlined,
  CloseOutlined,
} from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import { Markdown } from '../components/Markdown';
import * as api from '../api/client';
import { useAppStore } from '../store';

const { TextArea } = Input;

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
  const [viewMode, setViewMode] = useState<'preview' | 'code' | 'edit'>('preview');
  const [editContent, setEditContent] = useState('');
  const [editMode, setEditMode] = useState(false);

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

  const treeData = filesData?.items
    ? buildTreeData(filesData.items, '')
    : [];

  const handleSelect = (_: unknown, { node }: { node: DataNode }) => {
    const key = node.key as string;
    if (node.isLeaf) {
      setSelectedFile(key);
      setViewMode('preview');
      setEditMode(false);
    } else {
      setSelectedFile(null);
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
      <div className="flex min-h-0 flex-1 items-center justify-center p-6">
        <Spin size="large" />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col p-6">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-300 bg-clip-text text-transparent">
            工作区
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            列出和编辑 Bot 工作区文件
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            icon={<ReloadOutlined />}
            onClick={() => {
              queryClient.invalidateQueries({ queryKey: ['workspace-files', currentBotId] });
              queryClient.invalidateQueries({ queryKey: ['workspace-file', currentBotId] });
            }}
          />
          {selectedFile && !editMode && (
            <Segmented
              value={viewMode}
              options={[
                { label: '预览', value: 'preview' },
                { label: '代码', value: 'code' },
                { label: '编辑', value: 'edit' },
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
                保存
              </Button>
              <Button icon={<CloseOutlined />} onClick={cancelEdit}>
                取消
              </Button>
            </>
          )}
        </div>
      </div>

      <div className="mt-4 flex min-h-0 min-w-0 flex-1 gap-6">
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
              onSelect={handleSelect}
              blockNode
            />
          ) : (
            <Empty description="暂无文件" className="py-8" />
          )}
        </Card>

        <Card
          className="flex-1 min-h-0 overflow-hidden flex flex-col rounded-2xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shadow-sm hover:shadow-md transition-shadow"
          styles={{ body: { padding: '2rem 2.5rem', flex: 1, minHeight: 0, overflowY: 'auto' } }}
        >
          {!selectedFile ? (
            <div className="flex-1 flex flex-col items-center justify-center min-h-[200px]">
              <Empty description="从左侧选择文件" className="text-gray-500" />
            </div>
          ) : fileLoading ? (
            <div className="flex justify-center py-12">
              <Spin />
            </div>
          ) : editMode ? (
            <div className="flex flex-col gap-4">
              <TextArea
                value={editContent}
                onChange={(e) => setEditContent(e.target.value)}
                rows={24}
                className="font-mono text-sm"
                placeholder="编辑文件内容..."
              />
              <div className="flex gap-2 shrink-0">
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  onClick={saveEdit}
                  loading={updateMutation.isPending}
                >
                  保存
                </Button>
                <Button icon={<CloseOutlined />} onClick={cancelEdit}>
                  取消
                </Button>
              </div>
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
    </div>
  );
}
