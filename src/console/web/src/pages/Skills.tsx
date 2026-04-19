import { useState, useMemo, useEffect, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Form,
  Input,
  Button,
  Spin,
  Typography,
  Space,
  Tag,
  Modal,
  Select,
  Empty,
  Switch,
  Row,
  Col,
  Dropdown,
} from 'antd';
import {
  ReadOutlined,
  EditOutlined,
  DeleteOutlined,
  PlusOutlined,
  EyeOutlined,
  FileOutlined,
  FolderOutlined,
  FolderAddOutlined,
  CaretRightOutlined,
  CaretDownOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons';
import { Markdown } from '../components/Markdown';
import { useTranslation } from 'react-i18next';
import * as api from '../api/client';
import { useAppStore } from '../store';

const { Text } = Typography;

type SkillTabKey = 'builtin' | 'workspace';

type RegistrySkill = { name: string; description?: string; url?: string; version?: string };

type BundleEntryRow =
  | { id: string; kind: 'file'; path: string; content: string }
  | { id: string; kind: 'dir'; path: string };

/** Normalize a skill-bundle relative path (must match server rules). */
function normalizeSkillBundlePath(raw: string): string {
  const parts: string[] = [];
  for (const segment of raw
    .replace(/\\/g, '/')
    .trim()
    .replace(/^\/+/, '')
    .split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return '';
    if (!/^[a-zA-Z0-9._-]+$/.test(segment)) return '';
    parts.push(segment);
  }
  return parts.join('/');
}

/** Entry path is a strict child of folder ``parentNorm`` (incl. ``parent/`` placeholders). */
function bundlePathIsUnderParent(entryPathRaw: string, parentNorm: string): boolean {
  const en = normalizeSkillBundlePath(entryPathRaw);
  if (en && en.startsWith(`${parentNorm}/`)) return true;
  const trimmed = entryPathRaw.trim().replace(/\\/g, '/');
  if (trimmed.endsWith('/') && trimmed !== '/') {
    const inner = trimmed.replace(/\/+$/, '');
    return normalizeSkillBundlePath(inner) === parentNorm;
  }
  return false;
}

function bundlePathSortKey(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/');
  if (!trimmed) return '\uffff';
  if (trimmed.endsWith('/') && trimmed !== '/') {
    const inner = trimmed.replace(/\/+$/, '');
    const n = normalizeSkillBundlePath(inner);
    if (n) return `${n}/`;
  }
  const n = normalizeSkillBundlePath(raw);
  if (n) return n;
  return trimmed || '\uffff';
}

function bundleEntryTreeDepth(pathRaw: string): number {
  const trimmed = pathRaw.trim().replace(/\\/g, '/');
  if (!trimmed) return 0;
  if (trimmed.endsWith('/') && trimmed !== '/') {
    const inner = trimmed.replace(/\/+$/, '');
    const n = normalizeSkillBundlePath(inner);
    if (n) return n.split('/').length + 1;
  }
  const n = normalizeSkillBundlePath(pathRaw);
  if (!n) return 0;
  return n.split('/').length;
}

function bundleDirHasChildren(
  dirId: string,
  dirPathRaw: string,
  entries: BundleEntryRow[],
): boolean {
  const dnorm = normalizeSkillBundlePath(dirPathRaw);
  if (!dnorm) return false;
  return entries.some((e) => {
    if (e.id === dirId) return false;
    return bundlePathIsUnderParent(e.path, dnorm);
  });
}

function bundleEntryHiddenByCollapsedDirs(
  entry: BundleEntryRow,
  collapsedDirIds: Set<string>,
  entries: BundleEntryRow[],
): boolean {
  for (const cid of collapsedDirIds) {
    const dir = entries.find((e) => e.id === cid && e.kind === 'dir');
    if (!dir || dir.id === entry.id) continue;
    const dnorm = normalizeSkillBundlePath(dir.path);
    if (!dnorm) continue;
    if (bundlePathIsUnderParent(entry.path, dnorm)) return true;
  }
  return false;
}

/** Parse SKILL.md content to extract description and body (workspace skills have frontmatter). */
function parseSkillContent(full: string): { description: string; body: string } {
  const match = full.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { description: '', body: full };
  const [, frontmatter, body] = match;
  const descMatch = frontmatter.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
  return {
    description: descMatch ? descMatch[1].replace(/\\"/g, '"') : '',
    body: (body || '').trim(),
  };
}

type WorkspaceListNode = {
  name: string;
  path: string;
  is_dir: boolean;
  children?: WorkspaceListNode[];
};

function skillWsPathToBundleRel(wsPath: string, wsPrefix: string): string | null {
  const normalizedPath = wsPath.replace(/\\/g, '/');
  const prefix = wsPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${prefix}/`) && normalizedPath !== prefix) {
    return null;
  }
  return normalizedPath === prefix ? '' : normalizedPath.slice(prefix.length + 1);
}

async function workspaceSkillTreeToBundleRows(
  items: WorkspaceListNode[],
  wsPrefix: string,
  botId: string | null,
  nextId: () => string,
): Promise<BundleEntryRow[]> {
  const rows: BundleEntryRow[] = [];
  const walk = (nodes: WorkspaceListNode[]) => {
    for (const node of nodes) {
      const bundleRel = skillWsPathToBundleRel(node.path, wsPrefix);
      if (bundleRel === null) continue;
      if (bundleRel.toUpperCase() === 'SKILL.MD') continue;
      if (node.is_dir) {
        rows.push({ id: nextId(), kind: 'dir', path: bundleRel });
        if (node.children?.length) {
          walk(node.children);
        }
      } else {
        rows.push({ id: nextId(), kind: 'file', path: bundleRel, content: '' });
      }
    }
  };
  walk(items);
  rows.sort((a, b) =>
    bundlePathSortKey(a.path).localeCompare(bundlePathSortKey(b.path)),
  );
  await Promise.all(
    rows.map(async (row) => {
      if (row.kind !== 'file') return;
      const fileRes = await api.getWorkspaceFile(`${wsPrefix}/${row.path}`, botId);
      row.content = fileRes.content;
    }),
  );
  return rows;
}

function deriveEditDescription(skillMarkdown: string, listDescription: string): string {
  const { description } = parseSkillContent(skillMarkdown);
  if (description.trim()) return description;
  if (listDescription.trim()) return listDescription;
  return '';
}

function collectBundlePayloadFromRows(
  rows: BundleEntryRow[],
  t: (key: string) => string,
  addToast: (args: { type: 'error'; message: string }) => void,
): { files: Record<string, string>; directories: string[] } | null {
  const files: Record<string, string> = {};
  const directories: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'dir') {
      const trimmedPath = row.path.trim();
      if (!trimmedPath) continue;
      if (trimmedPath.replace(/\\/g, '/').endsWith('/')) {
        addToast({ type: 'error', message: t('skills.bundlePathTrailingSlash') });
        return null;
      }
      const rel = normalizeSkillBundlePath(row.path);
      if (!rel) {
        addToast({ type: 'error', message: t('skills.bundlePathInvalid') });
        return null;
      }
      const leaf = rel.split('/').pop() || '';
      if (leaf.toUpperCase() === 'SKILL.MD') {
        addToast({ type: 'error', message: t('skills.bundleSkillMdReserved') });
        return null;
      }
      if (seen.has(rel)) {
        addToast({ type: 'error', message: t('skills.bundleDuplicatePath') });
        return null;
      }
      seen.add(rel);
      directories.push(rel);
      continue;
    }
    const trimmedPath = row.path.trim();
    const hasPath = trimmedPath.length > 0;
    const hasBody = row.content.trim().length > 0;
    if (!hasPath && !hasBody) continue;
    if (!hasPath && hasBody) {
      addToast({ type: 'error', message: t('skills.bundlePathInvalid') });
      return null;
    }
    if (trimmedPath.replace(/\\/g, '/').endsWith('/')) {
      addToast({ type: 'error', message: t('skills.bundlePathTrailingSlash') });
      return null;
    }
    const rel = normalizeSkillBundlePath(row.path);
    if (!rel) {
      addToast({ type: 'error', message: t('skills.bundlePathInvalid') });
      return null;
    }
    const leaf = rel.split('/').pop() || '';
    if (leaf.toUpperCase() === 'SKILL.MD') {
      addToast({ type: 'error', message: t('skills.bundleSkillMdReserved') });
      return null;
    }
    if (seen.has(rel)) {
      addToast({ type: 'error', message: t('skills.bundleDuplicatePath') });
      return null;
    }
    seen.add(rel);
    files[rel] = row.content;
  }
  return { files, directories };
}

function normalizeBundleRelForCompare(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizeSkillBundlePath(trimmed) || '';
}

function computeBundleDeleteRels(
  initial: { files: string[]; dirs: string[] } | null,
  rows: BundleEntryRow[],
): string[] {
  if (!initial) return [];
  const curFiles = new Set(
    rows
      .filter((row) => row.kind === 'file')
      .map((row) => normalizeBundleRelForCompare(row.path))
      .filter(Boolean),
  );
  const curDirs = new Set(
    rows
      .filter((row) => row.kind === 'dir')
      .map((row) => normalizeBundleRelForCompare(row.path))
      .filter(Boolean),
  );
  const out: string[] = [];
  for (const fileRel of initial.files) {
    if (!curFiles.has(fileRel)) out.push(fileRel);
  }
  for (const dirRel of initial.dirs) {
    if (!curDirs.has(dirRel)) out.push(dirRel);
  }
  return out;
}

type BundleEditorSectionProps = {
  t: (key: string) => string;
  draftName: string | undefined;
  bundleFiles: BundleEntryRow[];
  activeFile: 'skill' | 'bundle-root' | string;
  setActiveFile: React.Dispatch<React.SetStateAction<'skill' | 'bundle-root' | string>>;
  bundleRootCollapsed: boolean;
  setBundleRootCollapsed: React.Dispatch<React.SetStateAction<boolean>>;
  collapsedBundleDirIds: Set<string>;
  addBundleFile: () => void;
  addBundleDirectory: () => void;
  addBundleFileUnderDir: (dirRowId: string, dirPathRaw: string) => void;
  addBundleDirectoryUnderDir: (dirRowId: string, dirPathRaw: string) => void;
  removeBundleFile: (id: string) => void;
  toggleCollapsedBundleDir: (id: string) => void;
  updateBundleEntry: (id: string, patch: { path?: string; content?: string }) => void;
  visibleBundleTreeEntries: BundleEntryRow[];
};

function BundleEditorSection({
  t,
  draftName,
  bundleFiles,
  activeFile,
  setActiveFile,
  bundleRootCollapsed,
  setBundleRootCollapsed,
  collapsedBundleDirIds,
  addBundleFile,
  addBundleDirectory,
  addBundleFileUnderDir,
  addBundleDirectoryUnderDir,
  removeBundleFile,
  toggleCollapsedBundleDir,
  updateBundleEntry,
  visibleBundleTreeEntries,
}: BundleEditorSectionProps) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden lg:flex-row">
      <div
        className="
                flex max-h-72 w-full shrink-0 flex-col overflow-hidden rounded-xl border
                border-gray-200 bg-gray-50/90 dark:border-gray-700 dark:bg-gray-900/50
                lg:max-h-none lg:min-h-0 lg:w-72 xl:w-80
              "
      >
        <div className="text-xs font-medium px-3 py-2 border-b border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-400">
          {t('skills.bundleFileTree')}
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          <div
            className="
                    rounded-lg border border-dashed border-gray-300/90 dark:border-gray-600/80
                    bg-white/70 dark:bg-gray-800/50 overflow-hidden
                  "
          >
            <div
              className="
                      flex items-stretch gap-0.5 px-1.5 py-1
                      border-b border-gray-200/90 dark:border-gray-600/70
                      bg-white/60 dark:bg-gray-800/40
                    "
            >
              <div className="w-[22px] shrink-0 flex items-center justify-center">
                <Button
                  type="text"
                  size="small"
                  className="!p-0 !min-w-[22px] !h-7 text-gray-500 dark:text-gray-400"
                  aria-expanded={!bundleRootCollapsed}
                  aria-label={
                    bundleRootCollapsed
                      ? t('skills.expandBundleFolder')
                      : t('skills.collapseBundleFolder')
                  }
                  icon={
                    bundleRootCollapsed ? (
                      <CaretRightOutlined className="text-xs" />
                    ) : (
                      <CaretDownOutlined className="text-xs" />
                    )
                  }
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    if (bundleRootCollapsed) {
                      setBundleRootCollapsed(false);
                      setActiveFile('skill');
                    } else {
                      setBundleRootCollapsed(true);
                      setActiveFile('bundle-root');
                    }
                  }}
                />
              </div>
              <button
                type="button"
                title={t('skills.bundleSkillRootHint')}
                onClick={() => {
                  setBundleRootCollapsed(false);
                  setActiveFile('bundle-root');
                }}
                className={`
                        flex flex-1 min-w-0 items-center gap-2 text-left px-2 py-2 rounded-lg text-sm transition-colors
                        ${activeFile === 'bundle-root'
                          ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                          : 'text-gray-800 dark:text-gray-100 hover:bg-gray-100/80 dark:hover:bg-gray-800/60'
                        }
                      `}
              >
                <FolderOutlined className="text-primary-600 dark:text-primary-400 shrink-0 text-base" />
                <span className="truncate font-mono text-xs font-semibold">
                  {draftName?.trim() || t('skills.bundleRootNamePlaceholder')}
                </span>
              </button>
            </div>
            {!bundleRootCollapsed && (
              <div className="px-1.5 py-1.5 bg-gray-50/50 dark:bg-gray-900/35">
                <div
                  className="
                        space-y-0.5 border-l-2 border-primary-300/70 dark:border-primary-600/45
                        ml-2 pl-2.5
                      "
                  role="group"
                  aria-label={t('skills.bundleSkillRootHint')}
                >
                  <div className="flex w-full min-w-0 items-stretch gap-1">
                    <div className="w-[22px] shrink-0 flex items-center justify-center">
                      <span
                        className="flex size-[22px] items-center justify-center text-sm text-gray-300 dark:text-gray-600 select-none"
                        aria-hidden
                      >
                        ·
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setActiveFile('skill')}
                      className={`
                            flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm transition-colors
                            ${activeFile === 'skill'
                              ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/80'
                            }
                          `}
                    >
                      <FileOutlined className="text-base shrink-0 opacity-80" />
                      <span className="truncate">{t('skills.bundleMainDoc')}</span>
                    </button>
                  </div>
                  {visibleBundleTreeEntries.map((row) => {
                    const depth = bundleEntryTreeDepth(row.path);
                    const indentPx = Math.max(0, depth - 1) * 14;
                    const hasTreeChildren =
                      row.kind === 'dir' &&
                      bundleDirHasChildren(row.id, row.path, bundleFiles);
                    const isCollapsed = collapsedBundleDirIds.has(row.id);
                    return (
                      <div
                        key={row.id}
                        className="flex items-stretch gap-1"
                        style={{ paddingLeft: indentPx }}
                      >
                        <div className="flex flex-1 min-w-0 items-stretch gap-0.5">
                          <div className="w-[22px] shrink-0 flex items-center justify-center">
                            {hasTreeChildren ? (
                              <Button
                                type="text"
                                size="small"
                                className="!p-0 !min-w-[22px] !h-7 text-gray-500 dark:text-gray-400"
                                aria-expanded={!isCollapsed}
                                aria-label={
                                  isCollapsed
                                    ? t('skills.expandBundleFolder')
                                    : t('skills.collapseBundleFolder')
                                }
                                icon={
                                  isCollapsed ? (
                                    <CaretRightOutlined className="text-xs" />
                                  ) : (
                                    <CaretDownOutlined className="text-xs" />
                                  )
                                }
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  toggleCollapsedBundleDir(row.id);
                                }}
                              />
                            ) : row.kind === 'file' ? (
                              <span
                                className="w-[22px] shrink-0 flex items-center justify-center text-sm text-gray-300 dark:text-gray-600 select-none"
                                aria-hidden
                              >
                                ·
                              </span>
                            ) : (
                              <span className="inline-block w-[22px]" aria-hidden />
                            )}
                          </div>
                          <button
                            type="button"
                            onClick={() => setActiveFile(row.id)}
                            className={`
                            flex-1 min-w-0 flex items-center gap-2 text-left px-2 py-2 rounded-lg text-sm transition-colors
                            ${activeFile === row.id
                              ? 'bg-primary-50 dark:bg-primary-900/30 text-primary-700 dark:text-primary-300 font-medium'
                              : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800/80'
                            }
                          `}
                          >
                            {row.kind === 'dir' ? (
                              <FolderOutlined className="text-base shrink-0 opacity-80" />
                            ) : (
                              <FileOutlined className="text-base shrink-0 opacity-80" />
                            )}
                            <span className="truncate font-mono text-xs">
                              {row.path.trim()
                                || (row.kind === 'dir'
                                  ? t('skills.bundleUntitledDir')
                                  : t('skills.bundleUntitledFile'))}
                            </span>
                          </button>
                        </div>
                        {row.kind === 'dir' && (
                          <Dropdown
                            menu={{
                              items: [
                                {
                                  key: 'file',
                                  label: t('skills.addFileUnderFolder'),
                                  icon: <FileOutlined />,
                                },
                                {
                                  key: 'dir',
                                  label: t('skills.addDirectoryUnderFolder'),
                                  icon: <FolderAddOutlined />,
                                },
                              ],
                              onClick: ({ key, domEvent }) => {
                                domEvent.stopPropagation();
                                if (key === 'file') {
                                  addBundleFileUnderDir(row.id, row.path);
                                } else {
                                  addBundleDirectoryUnderDir(row.id, row.path);
                                }
                              },
                            }}
                            trigger={['click']}
                            placement="bottomRight"
                            getPopupContainer={() => document.body}
                          >
                            <Button
                              type="text"
                              size="small"
                              className="!px-1 shrink-0 text-primary-600 dark:text-primary-400 hover:!text-primary-700 dark:hover:!text-primary-300"
                              icon={<PlusOutlined />}
                              aria-label={t('skills.addUnderFolderMenu')}
                              aria-haspopup="menu"
                              onClick={(event) => event.stopPropagation()}
                            />
                          </Dropdown>
                        )}
                        <Button
                          type="text"
                          size="small"
                          danger
                          className="!px-1 shrink-0"
                          aria-label={t('skills.removeBundleFile')}
                          onClick={() => removeBundleFile(row.id)}
                        >
                          <DeleteOutlined />
                        </Button>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="p-2 border-t border-gray-200 dark:border-gray-700 flex flex-col gap-2">
          <Button
            type="dashed"
            size="small"
            block
            icon={<PlusOutlined />}
            onClick={addBundleFile}
          >
            {t('skills.addBundleFile')}
          </Button>
          <Button
            type="dashed"
            size="small"
            block
            icon={<FolderAddOutlined />}
            onClick={addBundleDirectory}
          >
            {t('skills.addBundleDirectory')}
          </Button>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
        {activeFile === 'bundle-root' ? (
          <div
            className="
                    rounded-xl border border-dashed border-gray-200 dark:border-gray-600
                    bg-gray-50/80 dark:bg-gray-900/40 px-4 py-6 text-sm text-gray-600 dark:text-gray-400
                  "
          >
            {t('skills.bundleRootSelectedHint')}
          </div>
        ) : activeFile === 'skill' ? (
          <Form.Item
            name="content"
            preserve
            label={t('skills.fieldContentBody')}
            className="mb-0 flex min-h-0 flex-1 flex-col [&_.ant-form-item-control]:min-h-0 [&_.ant-form-item-control]:w-full [&_.ant-form-item-control]:flex-1 [&_.ant-form-item-control-input]:flex [&_.ant-form-item-control-input]:min-h-0 [&_.ant-form-item-control-input]:w-full [&_.ant-form-item-control-input]:flex-1 [&_.ant-form-item-control-input]:flex-col [&_.ant-form-item-control-input-content]:flex [&_.ant-form-item-control-input-content]:min-h-0 [&_.ant-form-item-control-input-content]:w-full [&_.ant-form-item-control-input-content]:flex-1 [&_.ant-form-item-control-input-content]:flex-col [&_.ant-form-item-row]:min-h-0 [&_.ant-form-item-row]:w-full [&_.ant-form-item-row]:flex-1 [&_.ant-form-item-row]:flex-col [&_textarea]:min-h-[14rem] [&_textarea]:w-full [&_textarea]:min-w-0 [&_textarea]:flex-1 [&_textarea]:resize-y"
          >
            <Input.TextArea
              className="font-mono text-sm min-h-[14rem] w-full min-w-0 flex-1 resize-y"
              placeholder={t('skills.contentPlaceholder')}
            />
          </Form.Item>
        ) : (
          (() => {
            const row = bundleFiles.find((entry) => entry.id === activeFile);
            if (!row) return null;
            if (row.kind === 'dir') {
              return (
                <>
                  <div>
                    <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">
                      {t('skills.bundleRelativePath')}
                    </div>
                    <Input
                      className="font-mono text-sm"
                      placeholder={t('skills.bundlePathDirPlaceholder')}
                      value={row.path}
                      onChange={(event) =>
                        updateBundleEntry(row.id, { path: event.target.value })
                      }
                    />
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                    {t('skills.bundleDirHint')}
                  </p>
                </>
              );
            }
            return (
              <>
                <div>
                  <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">
                    {t('skills.bundleRelativePath')}
                  </div>
                  <Input
                    className="font-mono text-sm"
                    placeholder={t('skills.bundlePathPlaceholder')}
                    value={row.path}
                    onChange={(event) =>
                      updateBundleEntry(row.id, { path: event.target.value })
                    }
                  />
                </div>
                <Input.TextArea
                  className="font-mono text-sm !min-h-[14rem]"
                  placeholder={t('skills.contentPlaceholder')}
                  value={row.content}
                  onChange={(event) =>
                    updateBundleEntry(row.id, { content: event.target.value })
                  }
                />
              </>
            );
          })()
        )}
      </div>
    </div>
  );
}

export default function Skills() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { addToast, currentBotId, setCurrentBotId } = useAppStore();
  const [activeTab, setActiveTab] = useState<SkillTabKey>('builtin');
  const [skillViewModal, setSkillViewModal] = useState<{ name: string; content: string } | null>(null);
  const [skillViewMode, setSkillViewMode] = useState<'raw' | 'preview'>('preview');
  const [skillEditModal, setSkillEditModal] = useState<{ name: string } | null>(null);
  const [skillCreateModal, setSkillCreateModal] = useState(false);
  const [skillCreateForm] = Form.useForm<{ name: string; description: string; content: string }>();
  const [skillEditForm] = Form.useForm<{ name: string; description: string; content: string }>();
  const createSkillDraftName = Form.useWatch('name', skillCreateForm) as string | undefined;
  const editSkillDraftName = Form.useWatch('name', skillEditForm) as string | undefined;
  const [registryUrl, setRegistryUrl] = useState('');
  const [registrySearch, setRegistrySearch] = useState('');
  const [createBundleFiles, setCreateBundleFiles] = useState<BundleEntryRow[]>([]);
  const [createActiveFile, setCreateActiveFile] = useState<
    'skill' | 'bundle-root' | string
  >('skill');
  const [skillBundleRootCollapsed, setSkillBundleRootCollapsed] = useState(false);
  const [collapsedBundleDirIds, setCollapsedBundleDirIds] = useState<Set<string>>(
    () => new Set(),
  );
  const bundleRowIdRef = useRef(0);
  const [editBundleFiles, setEditBundleFiles] = useState<BundleEntryRow[]>([]);
  const [editActiveFile, setEditActiveFile] = useState<'skill' | 'bundle-root' | string>(
    'skill',
  );
  const [editBundleRootCollapsed, setEditBundleRootCollapsed] = useState(false);
  const [editCollapsedBundleDirIds, setEditCollapsedBundleDirIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [editBundleLoading, setEditBundleLoading] = useState(false);
  const editBundleRowIdRef = useRef(0);
  const editInitialSnapshotRef = useRef<{ files: string[]; dirs: string[] } | null>(null);

  const sortedBundleTreeEntries = useMemo(
    () =>
      [...createBundleFiles].sort((a, b) =>
        bundlePathSortKey(a.path).localeCompare(bundlePathSortKey(b.path)),
      ),
    [createBundleFiles],
  );

  const visibleBundleTreeEntries = useMemo(
    () =>
      sortedBundleTreeEntries.filter(
        (e) =>
          !bundleEntryHiddenByCollapsedDirs(e, collapsedBundleDirIds, createBundleFiles),
      ),
    [sortedBundleTreeEntries, collapsedBundleDirIds, createBundleFiles],
  );

  const sortedEditBundleTreeEntries = useMemo(
    () =>
      [...editBundleFiles].sort((a, b) =>
        bundlePathSortKey(a.path).localeCompare(bundlePathSortKey(b.path)),
      ),
    [editBundleFiles],
  );

  const visibleEditBundleTreeEntries = useMemo(
    () =>
      sortedEditBundleTreeEntries.filter(
        (entry) =>
          !bundleEntryHiddenByCollapsedDirs(
            entry,
            editCollapsedBundleDirIds,
            editBundleFiles,
          ),
      ),
    [sortedEditBundleTreeEntries, editCollapsedBundleDirIds, editBundleFiles],
  );

  const skillTabs = useMemo(
    () =>
      [
        { key: 'builtin' as const, label: t('skills.tabBuiltin') },
        { key: 'workspace' as const, label: t('skills.tabWorkspace') },
      ] satisfies { key: SkillTabKey; label: string }[],
    [t],
  );

  const { data: bots } = useQuery({
    queryKey: ['bots'],
    queryFn: api.listBots,
  });

  const { data: skills, isLoading: skillsLoading } = useQuery({
    queryKey: ['skills', currentBotId],
    queryFn: () => api.listSkills(currentBotId),
  });

  /** Skills live under workspace ``.cursor/skills``; keep file tree in sync. */
  const invalidateSkillsAndWorkspaceFiles = () => {
    queryClient.invalidateQueries({ queryKey: ['skills'] });
    queryClient.invalidateQueries({ queryKey: ['workspace-files'] });
    queryClient.invalidateQueries({ queryKey: ['workspace-file'] });
  };

  const { data: registrySkills = [], isLoading: registryLoading } = useQuery({
    queryKey: ['skills-registry', registryUrl, registrySearch, currentBotId],
    queryFn: () => api.searchSkillsRegistry(registrySearch || undefined, registryUrl || undefined, currentBotId),
    enabled: !!registryUrl.trim(),
  });

  const installFromRegistryMutation = useMutation({
    mutationFn: (name: string) =>
      api.installSkillFromRegistry(name, currentBotId, registryUrl || undefined),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skills.installed') });
      invalidateSkillsAndWorkspaceFiles();
    },
    onError: (e) => addToast({ type: 'error', message: String(e) }),
  });

  const updateConfigMutation = useMutation({
    mutationFn: ({ section, data }: { section: string; data: Record<string, unknown> }) =>
      api.updateConfig(section, data, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('settings.saved') });
      queryClient.invalidateQueries({ queryKey: ['config'] });
      queryClient.invalidateQueries({ queryKey: ['skills'] });
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const updateSkillBundleMutation = useMutation({
    mutationFn: (vars: {
      name: string;
      content: string;
      files?: Record<string, string>;
      directories?: string[];
      delete_rels?: string[];
    }) =>
      api.updateSkillBundle(
        vars.name,
        {
          content: vars.content,
          files: vars.files,
          directories: vars.directories,
          delete_rels: vars.delete_rels,
        },
        currentBotId,
      ),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skills.updated') });
      setSkillEditModal(null);
      skillEditForm.resetFields();
      setEditBundleFiles([]);
      setEditActiveFile('skill');
      setEditBundleRootCollapsed(false);
      setEditCollapsedBundleDirIds(new Set());
      editInitialSnapshotRef.current = null;
      invalidateSkillsAndWorkspaceFiles();
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const createSkillMutation = useMutation({
    mutationFn: (data: {
      name: string;
      description: string;
      content: string;
      files?: Record<string, string>;
      directories?: string[];
    }) => api.createSkill(data, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skills.created') });
      setSkillCreateModal(false);
      skillCreateForm.resetFields();
      setCreateBundleFiles([]);
      setCreateActiveFile('skill');
      setSkillBundleRootCollapsed(false);
      setCollapsedBundleDirIds(new Set());
      invalidateSkillsAndWorkspaceFiles();
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const deleteSkillMutation = useMutation({
    mutationFn: (name: string) => api.deleteSkill(name, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skills.deleted') });
      invalidateSkillsAndWorkspaceFiles();
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  const copyToWorkspaceMutation = useMutation({
    mutationFn: (name: string) => api.copySkillToWorkspace(name, currentBotId),
    onSuccess: () => {
      addToast({ type: 'success', message: t('skills.copied') });
      invalidateSkillsAndWorkspaceFiles();
    },
    onError: (error) => {
      addToast({ type: 'error', message: String(error) });
    },
  });

  useEffect(() => {
    if (!skillCreateModal) return;
    setCreateBundleFiles([]);
    setCreateActiveFile('skill');
    bundleRowIdRef.current = 0;
    setSkillBundleRootCollapsed(false);
    setCollapsedBundleDirIds(new Set());
    skillCreateForm.resetFields();
    skillCreateForm.setFieldsValue({
      name: `unname-skill-${Date.now()}`,
    });
  }, [skillCreateModal, skillCreateForm]);

  useEffect(() => {
    if (createActiveFile === 'skill' || createActiveFile === 'bundle-root') return;
    if (!createBundleFiles.some((r) => r.id === createActiveFile)) {
      setCreateActiveFile('skill');
    }
  }, [createBundleFiles, createActiveFile]);

  useEffect(() => {
    if (createActiveFile === 'skill' || createActiveFile === 'bundle-root') return;
    if (!visibleBundleTreeEntries.some((r) => r.id === createActiveFile)) {
      setCreateActiveFile('skill');
    }
  }, [visibleBundleTreeEntries, createActiveFile]);

  useEffect(() => {
    if (!skillEditModal) return;
    if (editActiveFile === 'skill' || editActiveFile === 'bundle-root') return;
    if (!editBundleFiles.some((row) => row.id === editActiveFile)) {
      setEditActiveFile('skill');
    }
  }, [skillEditModal, editBundleFiles, editActiveFile]);

  useEffect(() => {
    if (!skillEditModal) return;
    if (editActiveFile === 'skill' || editActiveFile === 'bundle-root') return;
    if (!visibleEditBundleTreeEntries.some((row) => row.id === editActiveFile)) {
      setEditActiveFile('skill');
    }
  }, [skillEditModal, visibleEditBundleTreeEntries, editActiveFile]);

  const addCreateBundleFile = () => {
    bundleRowIdRef.current += 1;
    const id = `b-${bundleRowIdRef.current}`;
    const newRow: BundleEntryRow = { id, kind: 'file', path: '', content: '' };
    setCreateBundleFiles((rows) =>
      createActiveFile === 'bundle-root' ? [newRow, ...rows] : [...rows, newRow],
    );
    setCreateActiveFile(id);
  };

  const addCreateBundleDirectory = () => {
    bundleRowIdRef.current += 1;
    const id = `b-${bundleRowIdRef.current}`;
    const newRow: BundleEntryRow = { id, kind: 'dir', path: '' };
    setCreateBundleFiles((rows) =>
      createActiveFile === 'bundle-root' ? [newRow, ...rows] : [...rows, newRow],
    );
    setCreateActiveFile(id);
  };

  const addCreateBundleFileUnderDir = (dirRowId: string, dirPathRaw: string) => {
    const base = normalizeSkillBundlePath(dirPathRaw);
    if (!base) {
      addToast({ type: 'warning', message: t('skills.bundleNeedDirPath') });
      return;
    }
    bundleRowIdRef.current += 1;
    const newId = `b-${bundleRowIdRef.current}`;
    const prefix = `${base}/`;
    setCreateBundleFiles((rows) => {
      const idx = rows.findIndex((r) => r.id === dirRowId);
      const newRow: BundleEntryRow = {
        id: newId,
        kind: 'file',
        path: prefix,
        content: '',
      };
      if (idx === -1) {
        return [...rows, newRow];
      }
      const next = [...rows];
      next.splice(idx + 1, 0, newRow);
      return next;
    });
    setCreateActiveFile(newId);
  };

  const addCreateBundleDirectoryUnderDir = (dirRowId: string, dirPathRaw: string) => {
    const base = normalizeSkillBundlePath(dirPathRaw);
    if (!base) {
      addToast({ type: 'warning', message: t('skills.bundleNeedDirPath') });
      return;
    }
    bundleRowIdRef.current += 1;
    const newId = `b-${bundleRowIdRef.current}`;
    const prefix = `${base}/`;
    setCreateBundleFiles((rows) => {
      const idx = rows.findIndex((r) => r.id === dirRowId);
      const newRow: BundleEntryRow = {
        id: newId,
        kind: 'dir',
        path: prefix,
      };
      if (idx === -1) {
        return [...rows, newRow];
      }
      const next = [...rows];
      next.splice(idx + 1, 0, newRow);
      return next;
    });
    setCreateActiveFile(newId);
  };

  const removeCreateBundleFile = (id: string) => {
    setCollapsedBundleDirIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setCreateBundleFiles((rows) => rows.filter((r) => r.id !== id));
    setCreateActiveFile((cur) => (cur === id ? 'skill' : cur));
  };

  const toggleCollapsedBundleDir = (id: string) => {
    setCollapsedBundleDirIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateCreateBundleEntry = (
    id: string,
    patch: { path?: string; content?: string }
  ) => {
    setCreateBundleFiles((rows) =>
      rows.map((r) => {
        if (r.id !== id) return r;
        if (r.kind === 'dir') {
          return {
            ...r,
            ...(patch.path !== undefined ? { path: patch.path } : {}),
          };
        }
        return {
          ...r,
          ...(patch.path !== undefined ? { path: patch.path } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
        };
      })
    );
  };

  const addEditBundleFile = () => {
    editBundleRowIdRef.current += 1;
    const id = `e-${editBundleRowIdRef.current}`;
    const newRow: BundleEntryRow = { id, kind: 'file', path: '', content: '' };
    setEditBundleFiles((rows) =>
      editActiveFile === 'bundle-root' ? [newRow, ...rows] : [...rows, newRow],
    );
    setEditActiveFile(id);
  };

  const addEditBundleDirectory = () => {
    editBundleRowIdRef.current += 1;
    const id = `e-${editBundleRowIdRef.current}`;
    const newRow: BundleEntryRow = { id, kind: 'dir', path: '' };
    setEditBundleFiles((rows) =>
      editActiveFile === 'bundle-root' ? [newRow, ...rows] : [...rows, newRow],
    );
    setEditActiveFile(id);
  };

  const addEditBundleFileUnderDir = (dirRowId: string, dirPathRaw: string) => {
    const base = normalizeSkillBundlePath(dirPathRaw);
    if (!base) {
      addToast({ type: 'warning', message: t('skills.bundleNeedDirPath') });
      return;
    }
    editBundleRowIdRef.current += 1;
    const newId = `e-${editBundleRowIdRef.current}`;
    const prefix = `${base}/`;
    setEditBundleFiles((rows) => {
      const idx = rows.findIndex((r) => r.id === dirRowId);
      const newRow: BundleEntryRow = {
        id: newId,
        kind: 'file',
        path: prefix,
        content: '',
      };
      if (idx === -1) {
        return [...rows, newRow];
      }
      const next = [...rows];
      next.splice(idx + 1, 0, newRow);
      return next;
    });
    setEditActiveFile(newId);
  };

  const addEditBundleDirectoryUnderDir = (dirRowId: string, dirPathRaw: string) => {
    const base = normalizeSkillBundlePath(dirPathRaw);
    if (!base) {
      addToast({ type: 'warning', message: t('skills.bundleNeedDirPath') });
      return;
    }
    editBundleRowIdRef.current += 1;
    const newId = `e-${editBundleRowIdRef.current}`;
    const prefix = `${base}/`;
    setEditBundleFiles((rows) => {
      const idx = rows.findIndex((r) => r.id === dirRowId);
      const newRow: BundleEntryRow = {
        id: newId,
        kind: 'dir',
        path: prefix,
      };
      if (idx === -1) {
        return [...rows, newRow];
      }
      const next = [...rows];
      next.splice(idx + 1, 0, newRow);
      return next;
    });
    setEditActiveFile(newId);
  };

  const removeEditBundleFile = (id: string) => {
    setEditCollapsedBundleDirIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setEditBundleFiles((rows) => rows.filter((r) => r.id !== id));
    setEditActiveFile((cur) => (cur === id ? 'skill' : cur));
  };

  const toggleEditCollapsedBundleDir = (id: string) => {
    setEditCollapsedBundleDirIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const updateEditBundleEntry = (
    id: string,
    patch: { path?: string; content?: string }
  ) => {
    setEditBundleFiles((rows) =>
      rows.map((r) => {
        if (r.id !== id) return r;
        if (r.kind === 'dir') {
          return {
            ...r,
            ...(patch.path !== undefined ? { path: patch.path } : {}),
          };
        }
        return {
          ...r,
          ...(patch.path !== undefined ? { path: patch.path } : {}),
          ...(patch.content !== undefined ? { content: patch.content } : {}),
        };
      })
    );
  };

  const openWorkspaceSkillEdit = async (
    skillName: string,
    listDescription: string = '',
  ) => {
    setSkillEditModal({ name: skillName });
    setEditBundleLoading(true);
    editBundleRowIdRef.current = 0;
    try {
      const res = await api.getSkillContent(skillName, currentBotId);
      const wsPrefix = `.cursor/skills/${skillName}`;
      let nodes: WorkspaceListNode[] = [];
      try {
        const listed = await api.listWorkspaceFiles(wsPrefix, 32, currentBotId);
        nodes = listed.items as WorkspaceListNode[];
      } catch {
        nodes = [];
      }
      const rows = await workspaceSkillTreeToBundleRows(
        nodes,
        wsPrefix,
        currentBotId,
        () => {
          editBundleRowIdRef.current += 1;
          return `e-${editBundleRowIdRef.current}`;
        },
      );
      setEditBundleFiles(rows);
      editInitialSnapshotRef.current = {
        files: rows
          .filter((r) => r.kind === 'file')
          .map((r) => normalizeBundleRelForCompare(r.path))
          .filter(Boolean),
        dirs: rows
          .filter((r) => r.kind === 'dir')
          .map((r) => normalizeBundleRelForCompare(r.path))
          .filter(Boolean),
      };
      skillEditForm.resetFields();
      skillEditForm.setFieldsValue({
        name: skillName,
        description: deriveEditDescription(res.content, listDescription),
        content: res.content,
      });
      setEditActiveFile('skill');
      setEditBundleRootCollapsed(false);
      setEditCollapsedBundleDirIds(new Set());
    } catch (error) {
      addToast({ type: 'error', message: String(error) });
      setSkillEditModal(null);
    } finally {
      setEditBundleLoading(false);
    }
  };

  const handleEditBuiltin = async (skill: { name: string; description: string }) => {
    try {
      await copyToWorkspaceMutation.mutateAsync(skill.name);
      setActiveTab('workspace');
      await openWorkspaceSkillEdit(skill.name, skill.description);
    } catch {
      // Error already handled by mutation
    }
  };

  const SkillItemCard = ({
    skill,
    source,
    children,
  }: {
    skill: { name: string; description?: string; available?: boolean };
    source: 'builtin' | 'workspace';
    children: React.ReactNode;
  }) => (
    <div
      className={`
        group flex items-center justify-between gap-4 px-5 py-4 rounded-xl
        border border-gray-200/70 dark:border-gray-700/60
        bg-white dark:bg-gray-800/50
        hover:border-primary-300/60 dark:hover:border-primary-500/40
        hover:shadow-md hover:shadow-primary-500/5 dark:hover:shadow-primary-500/10
        transition-all duration-200
      `}
    >
      <div className="flex items-center gap-4 min-w-0 flex-1">
        <div className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-primary-50 to-primary-100 dark:from-primary-900/40 dark:to-primary-800/30 flex items-center justify-center">
          <ReadOutlined className="text-primary-500 dark:text-primary-400 text-base" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-gray-900 dark:text-gray-100 truncate">{skill.name}</p>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 line-clamp-1 hidden sm:block">
            {skill.description || t('skills.noDescription')}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Tag color={source === 'builtin' ? 'blue' : 'green'} className="!m-0">
            {source === 'builtin' ? t('skills.sourceBuiltin') : t('skills.sourceWorkspace')}
          </Tag>
          {skill.available === false && (
            <Tag color="warning" className="!m-0">{t('skills.unavailable')}</Tag>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">{children}</div>
    </div>
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between shrink-0">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold text-gray-900 dark:text-gray-100">
            {t('skills.title')}
          </h1>
          <p className="text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-0.5 hidden sm:block">
            {t('skills.subtitle')}
          </p>
        </div>
        <Space className="w-full sm:w-auto justify-end sm:justify-start" wrap>
          {bots && bots.length > 1 && (
            <Select
              value={currentBotId || bots.find((b) => b.is_default)?.id || bots[0]?.id}
              onChange={setCurrentBotId}
              options={bots.map((b) => ({ label: b.name, value: b.id }))}
              className="w-full min-w-[10rem] sm:w-40"
            />
          )}
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setSkillCreateModal(true)}
            className="shadow-md shadow-primary-500/25 w-full sm:w-auto"
          >
            <span className="hidden sm:inline">{t('skills.addSkill')}</span>
          </Button>
        </Space>
      </div>

      {/* Registry: URL + search in one row on wide screens */}
      <div className="p-4 rounded-xl border border-gray-200/80 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 shrink-0">
        <p className="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
          {t('skills.registryTitle')}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_18rem] sm:items-stretch sm:gap-2">
          <Input
            placeholder={t('skills.registryUrlPlaceholder')}
            value={registryUrl}
            onChange={(e) => setRegistryUrl(e.target.value)}
            className="min-w-0 border-gray-300 dark:border-gray-600 sm:h-full [&_.ant-input-affix-wrapper]:h-full"
            size="middle"
            allowClear
          />
          <Input.Search
            placeholder={t('skills.registrySearchPlaceholder')}
            value={registrySearch}
            onChange={(e) => setRegistrySearch(e.target.value)}
            onSearch={() => queryClient.invalidateQueries({ queryKey: ['skills-registry'] })}
            loading={registryLoading}
            enterButton={t('skills.search')}
            disabled={!registryUrl.trim()}
            className={`
              min-w-0 w-full sm:h-full
              !flex !flex-row !items-stretch
              [&_.ant-input-affix-wrapper]:min-w-0 [&_.ant-input-affix-wrapper]:flex-1 [&_.ant-input-affix-wrapper]:h-full
              [&_.ant-btn]:h-full [&_.ant-btn]:min-w-[4.5rem] [&_.ant-btn]:shrink-0
            `}
            size="middle"
            allowClear
          />
        </div>
        <div className="mt-3">
          {registryUrl.trim() && (
            registrySkills.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-200 dark:border-gray-600/80 bg-gray-50/80 dark:bg-gray-900/30 py-8 px-4">
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={registryLoading ? t('common.loading') : t('skills.registryEmpty')}
                />
              </div>
            ) : (
              <div className="space-y-3 max-h-[min(24rem,40vh)] overflow-y-auto pr-1 -mr-1">
                {registrySkills.map((s: RegistrySkill) => {
                  const installed = skills?.some((sk) => sk.name === s.name);
                  return (
                    <div
                      key={s.name}
                      className="flex items-center justify-between px-4 py-3 rounded-xl bg-gray-50 dark:bg-gray-800/60 border border-gray-100 dark:border-gray-700/50 hover:border-primary-200 dark:hover:border-primary-500/30 transition-colors"
                    >
                      <div>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{s.name}</p>
                        <Text type="secondary" className="text-xs">
                          {s.description || '-'}
                        </Text>
                      </div>
                      <Button
                        type="primary"
                        size="small"
                        disabled={!!installed}
                        loading={installFromRegistryMutation.isPending}
                        onClick={() => installFromRegistryMutation.mutate(s.name)}
                        className="!rounded-lg"
                      >
                        {installed ? t('skills.installedLabel') : t('skills.install')}
                      </Button>
                    </div>
                  );
                })}
              </div>
            )
          )}
        </div>
      </div>

      {skillsLoading ? (
        <div className="flex-1 flex items-center justify-center min-h-[12rem]">
          <Spin size="large" />
        </div>
      ) : !skills || skills.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center min-h-[min(20rem,45vh)] rounded-2xl border border-dashed border-gray-200/90 dark:border-gray-700/70 bg-gray-50/50 dark:bg-gray-800/20 px-6 py-10">
          <Empty description={t('skills.noSkills')} image={Empty.PRESENTED_IMAGE_SIMPLE} />
        </div>
      ) : (
        <div className="flex flex-col flex-1 min-h-0 gap-3">
          <div className="flex shrink-0 items-start gap-2 rounded-lg border border-primary-200/60 bg-primary-50/40 px-3 py-2 text-xs text-gray-600 dark:border-primary-800/50 dark:bg-primary-950/30 dark:text-gray-400">
            <InfoCircleOutlined className="mt-0.5 shrink-0 text-primary-500 dark:text-primary-400" />
            <span>{t('skills.restartCompact')}</span>
          </div>
          <div className="flex border-b border-gray-200 dark:border-gray-700 mb-0 gap-0 shrink-0">
            {skillTabs.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setActiveTab(key)}
                className={`
                  relative px-4 py-2.5 text-sm font-medium transition-all duration-200
                  ${activeTab === key
                    ? 'text-primary-600 dark:text-primary-400'
                    : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
                  }
                `}
              >
                {label}
                {activeTab === key && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary-500 rounded-full" />
                )}
              </button>
            ))}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pt-1 pb-1">
            {activeTab === 'builtin' ? (
              skills.filter((s) => s.source === 'builtin').length === 0 ? (
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-6">
                  <Empty description={t('skills.emptyBuiltin')} />
                </div>
              ) : (
                <div className="space-y-3">
                  {skills
                    .filter((s) => s.source === 'builtin')
                    .map((skill) => (
                      <SkillItemCard key={skill.name} skill={skill} source="builtin">
                        <Button
                          type="text"
                          size="middle"
                          icon={<EditOutlined />}
                          onClick={() => handleEditBuiltin(skill)}
                          loading={copyToWorkspaceMutation.isPending}
                          className="text-gray-600 dark:text-gray-400 hover:text-primary-500"
                        >
                          {t('skills.edit')}
                        </Button>
                        <Button
                          type="text"
                          size="middle"
                          icon={<EyeOutlined />}
                          onClick={async () => {
                            const res = await api.getSkillContent(skill.name, currentBotId);
                            setSkillViewModal({ name: res.name, content: res.content });
                            setSkillViewMode('preview');
                          }}
                          className="text-gray-600 dark:text-gray-400 hover:text-primary-500"
                        >
                          {t('skills.view')}
                        </Button>
                        <Switch
                          checked={skill.enabled}
                          onChange={(checked) =>
                            updateConfigMutation.mutate({
                              section: 'skills',
                              data: { [skill.name]: { enabled: checked } },
                            })
                          }
                        />
                      </SkillItemCard>
                    ))}
                </div>
              )
            ) : skills.filter((s) => s.source === 'workspace').length === 0 ? (
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center py-6">
                <Empty description={t('skills.emptyWorkspace')} />
              </div>
            ) : (
              <div className="space-y-3">
                {skills
                  .filter((s) => s.source === 'workspace')
                  .map((skill) => (
                    <SkillItemCard key={skill.name} skill={skill} source="workspace">
                      <Button
                        type="text"
                        size="middle"
                        icon={<EditOutlined />}
                        onClick={() =>
                          openWorkspaceSkillEdit(skill.name, skill.description || '')
                        }
                        className="text-gray-600 dark:text-gray-400 hover:text-primary-500"
                      >
                        {t('skills.edit')}
                      </Button>
                      <Button
                        type="text"
                        danger
                        size="middle"
                        icon={<DeleteOutlined />}
                        onClick={() => {
                          Modal.confirm({
                            title: t('skills.deleteConfirmTitle', { name: skill.name }),
                            content: t('skills.deleteConfirmContent'),
                            okText: t('common.delete'),
                            cancelText: t('common.cancel'),
                            okType: 'danger',
                            onOk: () => deleteSkillMutation.mutate(skill.name),
                          });
                        }}
                        className="hover:!text-red-500"
                      >
                        {t('skills.delete')}
                      </Button>
                    </SkillItemCard>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}

      <Modal
        title={
          skillViewModal ? t('skills.viewTitle', { name: skillViewModal.name }) : ''
        }
        open={!!skillViewModal}
        onCancel={() => setSkillViewModal(null)}
        footer={
          <div className="flex items-center justify-between w-full">
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => setSkillViewMode('preview')}
                className={`px-3 py-1 rounded text-sm ${skillViewMode === 'preview' ? 'bg-primary-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}
              >
                {t('skills.preview')}
              </button>
              <button
                type="button"
                onClick={() => setSkillViewMode('raw')}
                className={`px-3 py-1 rounded text-sm ${skillViewMode === 'raw' ? 'bg-primary-500 text-white' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-400'}`}
              >
                {t('skills.raw')}
              </button>
            </div>
            <Button onClick={() => setSkillViewModal(null)}>{t('skills.close')}</Button>
          </div>
        }
        width={700}
        destroyOnHidden
      >
        {skillViewModal && (
          <div className="overflow-auto max-h-[60vh]">
            {skillViewMode === 'raw' ? (
              <pre className="p-4 rounded-lg bg-gray-50 dark:bg-gray-900 text-sm font-mono whitespace-pre-wrap">
                {skillViewModal.content}
              </pre>
            ) : (
              <div className="p-4 prose prose-slate dark:prose-invert prose-sm max-w-none">
                <Markdown>{skillViewModal.content}</Markdown>
              </div>
            )}
          </div>
        )}
      </Modal>

      <Modal
        title={
          skillEditModal ? t('skills.editTitle', { name: skillEditModal.name }) : ''
        }
        open={!!skillEditModal}
        onCancel={() => {
          setSkillEditModal(null);
          skillEditForm.resetFields();
          setEditBundleFiles([]);
          setEditActiveFile('skill');
          setEditBundleRootCollapsed(false);
          setEditCollapsedBundleDirIds(new Set());
          editInitialSnapshotRef.current = null;
        }}
        footer={null}
        destroyOnHidden
        width={880}
        styles={{
          body: {
            paddingTop: 12,
            maxHeight: 'calc(100vh - 140px)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
      >
        {skillEditModal && (
          <>
            <p className="shrink-0 text-xs text-gray-500 dark:text-gray-400 mb-4">
              {t('skills.bundleHint')}
            </p>
            {editBundleLoading ? (
              <div className="flex justify-center py-16">
                <Spin size="large" />
              </div>
            ) : (
              <Form
                key={skillEditModal.name}
                form={skillEditForm}
                layout="vertical"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
                onFinish={(values) => {
                  if (!skillEditModal) return;
                  const payload = collectBundlePayloadFromRows(
                    editBundleFiles,
                    t,
                    addToast,
                  );
                  if (!payload) return;
                  const deleteRels = computeBundleDeleteRels(
                    editInitialSnapshotRef.current,
                    editBundleFiles,
                  );
                  const mainContent =
                    values.content?.trim() !== ''
                      ? values.content || ''
                      : `# ${values.name}\n\n${values.description}\n`;
                  updateSkillBundleMutation.mutate({
                    name: skillEditModal.name,
                    content: mainContent,
                    files:
                      Object.keys(payload.files).length > 0
                        ? payload.files
                        : undefined,
                    directories:
                      payload.directories.length > 0
                        ? payload.directories
                        : undefined,
                    delete_rels: deleteRels.length > 0 ? deleteRels : undefined,
                  });
                }}
              >
                <Row gutter={16} className="shrink-0">
                  <Col xs={24} md={12}>
                    <Form.Item name="name" label={t('skills.fieldName')}>
                      <Input readOnly className="font-mono bg-gray-50 dark:bg-gray-900/40" />
                    </Form.Item>
                  </Col>
                  <Col xs={24} md={12}>
                    <Form.Item
                      name="description"
                      label={t('skills.fieldDescription')}
                      rules={[{ required: true }]}
                    >
                      <Input placeholder={t('skills.descriptionPlaceholder')} />
                    </Form.Item>
                  </Col>
                </Row>

                <BundleEditorSection
                  t={t}
                  draftName={editSkillDraftName}
                  bundleFiles={editBundleFiles}
                  activeFile={editActiveFile}
                  setActiveFile={setEditActiveFile}
                  bundleRootCollapsed={editBundleRootCollapsed}
                  setBundleRootCollapsed={setEditBundleRootCollapsed}
                  collapsedBundleDirIds={editCollapsedBundleDirIds}
                  addBundleFile={addEditBundleFile}
                  addBundleDirectory={addEditBundleDirectory}
                  addBundleFileUnderDir={addEditBundleFileUnderDir}
                  addBundleDirectoryUnderDir={addEditBundleDirectoryUnderDir}
                  removeBundleFile={removeEditBundleFile}
                  toggleCollapsedBundleDir={toggleEditCollapsedBundleDir}
                  updateBundleEntry={updateEditBundleEntry}
                  visibleBundleTreeEntries={visibleEditBundleTreeEntries}
                />

                <Form.Item className="!mb-0 mt-4 shrink-0">
                  <div className="flex w-full justify-end">
                    <Space>
                      <Button
                        onClick={() => {
                          setSkillEditModal(null);
                          skillEditForm.resetFields();
                          setEditBundleFiles([]);
                          setEditActiveFile('skill');
                          setEditBundleRootCollapsed(false);
                          setEditCollapsedBundleDirIds(new Set());
                          editInitialSnapshotRef.current = null;
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                      <Button
                        type="primary"
                        htmlType="submit"
                        loading={updateSkillBundleMutation.isPending}
                      >
                        {t('common.save')}
                      </Button>
                    </Space>
                  </div>
                </Form.Item>
              </Form>
            )}
          </>
        )}
      </Modal>

      <Modal
        title={t('skills.createWorkspaceTitle')}
        open={skillCreateModal}
        onCancel={() => {
          setSkillCreateModal(false);
          skillCreateForm.resetFields();
          setCreateBundleFiles([]);
          setCreateActiveFile('skill');
          setSkillBundleRootCollapsed(false);
          setCollapsedBundleDirIds(new Set());
        }}
        footer={null}
        destroyOnHidden
        width={880}
        styles={{
          body: {
            paddingTop: 12,
            maxHeight: 'calc(100vh - 140px)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
          },
        }}
      >
        <p className="shrink-0 text-xs text-gray-500 dark:text-gray-400 mb-4">
          {t('skills.bundleHint')}
        </p>
        <Form
          form={skillCreateForm}
          layout="vertical"
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          onFinish={(values) => {
            const payload = collectBundlePayloadFromRows(
              createBundleFiles,
              t,
              addToast,
            );
            if (!payload) return;
            createSkillMutation.mutate({
              name: values.name,
              description: values.description,
              content: values.content || '',
              files:
                Object.keys(payload.files).length > 0 ? payload.files : undefined,
              directories:
                payload.directories.length > 0 ? payload.directories : undefined,
            });
          }}
        >
          <Row gutter={16} className="shrink-0">
            <Col xs={24} md={12}>
              <Form.Item
                name="name"
                label={t('skills.fieldName')}
                rules={[
                  { required: true },
                  {
                    pattern: /^[a-zA-Z0-9_-]+$/,
                    message: t('skills.nameRule'),
                  },
                ]}
              >
                <Input placeholder={t('skills.namePlaceholder')} />
              </Form.Item>
            </Col>
            <Col xs={24} md={12}>
              <Form.Item
                name="description"
                label={t('skills.fieldDescription')}
                rules={[{ required: true }]}
              >
                <Input placeholder={t('skills.descriptionPlaceholder')} />
              </Form.Item>
            </Col>
          </Row>

          <BundleEditorSection
            t={t}
            draftName={createSkillDraftName}
            bundleFiles={createBundleFiles}
            activeFile={createActiveFile}
            setActiveFile={setCreateActiveFile}
            bundleRootCollapsed={skillBundleRootCollapsed}
            setBundleRootCollapsed={setSkillBundleRootCollapsed}
            collapsedBundleDirIds={collapsedBundleDirIds}
            addBundleFile={addCreateBundleFile}
            addBundleDirectory={addCreateBundleDirectory}
            addBundleFileUnderDir={addCreateBundleFileUnderDir}
            addBundleDirectoryUnderDir={addCreateBundleDirectoryUnderDir}
            removeBundleFile={removeCreateBundleFile}
            toggleCollapsedBundleDir={toggleCollapsedBundleDir}
            updateBundleEntry={updateCreateBundleEntry}
            visibleBundleTreeEntries={visibleBundleTreeEntries}
          />
          <Form.Item className="!mb-0 mt-4 shrink-0">
            <div className="flex w-full justify-end">
              <Space>
                <Button
                  onClick={() => {
                    setSkillCreateModal(false);
                    skillCreateForm.resetFields();
                    setCreateBundleFiles([]);
                    setCreateActiveFile('skill');
                    setSkillBundleRootCollapsed(false);
                    setCollapsedBundleDirIds(new Set());
                  }}
                >
                  {t('common.cancel')}
                </Button>
                <Button
                  type="primary"
                  htmlType="submit"
                  loading={createSkillMutation.isPending}
                >
                  {t('skills.create')}
                </Button>
              </Space>
            </div>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
