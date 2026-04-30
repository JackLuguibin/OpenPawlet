import { useEffect, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { vscodeDark, vscodeLight } from '@uiw/codemirror-theme-vscode';
import type { Extension } from '@codemirror/state';
import { clsx } from 'clsx';
import { useAppStore } from '../store';

function resolveIsDark(theme: 'light' | 'dark' | 'system'): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

async function loadLanguageExtensionsForPath(path: string | null): Promise<Extension[]> {
  if (!path) return [];
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  const ext = dot >= 0 ? base.slice(dot).toLowerCase() : '';

  switch (ext) {
    case '.ts': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ typescript: true })];
    }
    case '.tsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ typescript: true, jsx: true })];
    }
    case '.js':
    case '.mjs':
    case '.cjs': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript()];
    }
    case '.jsx': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return [javascript({ jsx: true })];
    }
    case '.json':
    case '.jsonc': {
      const { json } = await import('@codemirror/lang-json');
      return [json()];
    }
    case '.md':
    case '.mdx': {
      const { markdown } = await import('@codemirror/lang-markdown');
      return [markdown()];
    }
    case '.py':
    case '.pyw': {
      const { python } = await import('@codemirror/lang-python');
      return [python()];
    }
    case '.yml':
    case '.yaml': {
      const { yaml } = await import('@codemirror/lang-yaml');
      return [yaml()];
    }
    case '.css': {
      const { css } = await import('@codemirror/lang-css');
      return [css()];
    }
    case '.html':
    case '.htm': {
      const { html } = await import('@codemirror/lang-html');
      return [html()];
    }
    case '.xml':
    case '.svg': {
      const { xml } = await import('@codemirror/lang-xml');
      return [xml()];
    }
    case '.sql': {
      const { sql } = await import('@codemirror/lang-sql');
      return [sql()];
    }
    case '.rs': {
      const { rust } = await import('@codemirror/lang-rust');
      return [rust()];
    }
    default:
      return [];
  }
}

export interface WorkspaceCodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  filePath: string | null;
  placeholder?: string;
  /** Merged onto the outer wrapper (layout / flex). */
  className?: string;
}

export function WorkspaceCodeEditor({
  value,
  onChange,
  filePath,
  placeholder,
  className: rootClassName,
}: WorkspaceCodeEditorProps) {
  const themePref = useAppStore((s) => s.theme);
  const [isDark, setIsDark] = useState(() => resolveIsDark(themePref));
  const [extensions, setExtensions] = useState<Extension[]>([]);

  useEffect(() => {
    setIsDark(resolveIsDark(themePref));
    if (themePref !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onSchemeChange = () => setIsDark(mq.matches);
    mq.addEventListener('change', onSchemeChange);
    return () => mq.removeEventListener('change', onSchemeChange);
  }, [themePref]);

  useEffect(() => {
    let cancelled = false;
    loadLanguageExtensionsForPath(filePath).then((loaded) => {
      if (!cancelled) setExtensions(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [filePath]);

  return (
    <div
      className={clsx(
        'min-h-0 h-full min-w-0 overflow-hidden rounded-md border border-gray-200/90 bg-white dark:border-gray-600/80 dark:bg-[#1e1e1e]',
        rootClassName,
      )}
    >
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

/** Direct child of `Form.Item`: Ant Design injects `value` / `onChange` at runtime. */
export type WorkspaceCodeEditorFormItemProps = Omit<WorkspaceCodeEditorProps, 'value' | 'onChange'> &
  Partial<Pick<WorkspaceCodeEditorProps, 'value' | 'onChange'>>;

export function WorkspaceCodeEditorForFormItem({
  value = '',
  onChange = () => {},
  ...rest
}: WorkspaceCodeEditorFormItemProps) {
  return <WorkspaceCodeEditor value={value} onChange={onChange} {...rest} />;
}
