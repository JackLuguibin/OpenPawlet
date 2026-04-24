import { useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { sql } from '@codemirror/lang-sql';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import type { Extension } from '@codemirror/state';
import { useAppStore } from '../store';

function resolveIsDark(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function languageExtensionsForPath(path: string | null): Extension[] {
  if (!path) return [];
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';

  switch (ext) {
    case '.ts':
      return [javascript({ typescript: true })];
    case '.tsx':
      return [javascript({ typescript: true, jsx: true })];
    case '.js':
    case '.mjs':
    case '.cjs':
      return [javascript()];
    case '.jsx':
      return [javascript({ jsx: true })];
    case '.json':
    case '.jsonc':
      return [json()];
    case '.md':
    case '.mdx':
      return [markdown()];
    case '.py':
    case '.pyw':
      return [python()];
    case '.yml':
    case '.yaml':
      return [yaml()];
    case '.css':
      return [css()];
    case '.html':
    case '.htm':
      return [html()];
    case '.xml':
    case '.svg':
      return [xml()];
    case '.sql':
      return [sql()];
    case '.rs':
      return [rust()];
    default:
      return [];
  }
}

export interface WorkspaceCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  filePath: string | null;
  placeholder?: string;
}

export function WorkspaceCodeEditor({
  value,
  onChange,
  filePath,
  placeholder,
}: WorkspaceCodeEditorProps) {
  const themePref = useAppStore((s) => s.theme);
  const [isDark, setIsDark] = useState(() => resolveIsDark(themePref));

  useEffect(() => {
    setIsDark(resolveIsDark(themePref));
    if (themePref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => setIsDark(mq.matches);
    mq.addEventListener('change', onSchemeChange);
    return () => mq.removeEventListener('change', onSchemeChange);
  }, [themePref]);

  const extensions = useMemo(() => languageExtensionsForPath(filePath), [filePath]);

  return (
    <div className="min-h-0 h-full min-w-0 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]">
      <CodeMirror
        value={value}
        height="100%"
        className="min-h-0 h-full text-sm [&_.cm-editor]:min-h-0 [&_.cm-editor]:h-full [&_.cm-scroller]:font-mono [&_.cm-focused]:outline-none"
        theme={isDark ? vscodeDark : vscodeLight}
        extensions={extensions}
        onChange={onChange}
        basicSetup
        placeholder={placeholder}
      />
    </div>
  );
}
