import * as api from '../../api/client';

export type BundleEntryRow =
  | { id: string; kind: 'file'; path: string; content: string }
  | { id: string; kind: 'dir'; path: string };

export type WorkspaceListNode = {
  name: string;
  path: string;
  is_dir: boolean;
  children?: WorkspaceListNode[];
};

/** Normalize a skill-bundle relative path (must match server rules). */
export function normalizeSkillBundlePath(raw: string): string {
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
export function bundlePathIsUnderParent(entryPathRaw: string, parentNorm: string): boolean {
  const en = normalizeSkillBundlePath(entryPathRaw);
  if (en && en.startsWith(`${parentNorm}/`)) return true;
  const trimmed = entryPathRaw.trim().replace(/\\/g, '/');
  if (trimmed.endsWith('/') && trimmed !== '/') {
    const inner = trimmed.replace(/\/+$/, '');
    return normalizeSkillBundlePath(inner) === parentNorm;
  }
  return false;
}

export function bundlePathSortKey(raw: string): string {
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

export function bundleEntryTreeDepth(pathRaw: string): number {
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

export function bundleDirHasChildren(
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

export function bundleEntryHiddenByCollapsedDirs(
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
export function parseSkillContent(full: string): { description: string; body: string } {
  const match = full.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) return { description: '', body: full };
  const [, frontmatter, body] = match;
  const descMatch = frontmatter.match(/description:\s*"((?:[^"\\]|\\.)*)"/);
  return {
    description: descMatch ? descMatch[1].replace(/\\"/g, '"') : '',
    body: (body || '').trim(),
  };
}

export function skillWsPathToBundleRel(wsPath: string, wsPrefix: string): string | null {
  const normalizedPath = wsPath.replace(/\\/g, '/');
  const prefix = wsPrefix.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedPath.startsWith(`${prefix}/`) && normalizedPath !== prefix) {
    return null;
  }
  return normalizedPath === prefix ? '' : normalizedPath.slice(prefix.length + 1);
}

export async function workspaceSkillTreeToBundleRows(
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

export function deriveEditDescription(skillMarkdown: string, listDescription: string): string {
  const { description } = parseSkillContent(skillMarkdown);
  if (description.trim()) return description;
  if (listDescription.trim()) return listDescription;
  return '';
}

export function collectBundlePayloadFromRows(
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

export function normalizeBundleRelForCompare(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  return normalizeSkillBundlePath(trimmed) || '';
}

export function computeBundleDeleteRels(
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
