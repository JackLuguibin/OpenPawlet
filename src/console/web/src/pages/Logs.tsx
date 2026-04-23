import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Switch, Tooltip, Tabs } from 'antd';
import { CopyOutlined, CheckOutlined, ReloadOutlined } from '@ant-design/icons';
import { FileText, Terminal } from 'lucide-react';
import { useAppStore } from '../store';
import * as api from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { RuntimeLogView } from '../components/RuntimeLogView';
import { formatQueryError } from '../utils/errors';
import type { RuntimeLogChunk } from '../api/types';

/** Default tail depth for runtime log API; Tab UI replaces per-source fetches. */
const RUNTIME_LOG_MAX_LINES = 2000;

function filterLines(text: string, q: string): string {
  if (!q.trim()) return text;
  const needle = q.toLowerCase();
  return text
    .split('\n')
    .filter((line) => line.toLowerCase().includes(needle))
    .join('\n');
}

function chunkKey(c: RuntimeLogChunk): string {
  return c.source;
}

type LogPanelVariant = 'stacked' | 'tab';

function LogPanel({
  label,
  chunk,
  onCopy,
  copied,
  t,
  variant = 'stacked',
}: {
  label: string;
  chunk: RuntimeLogChunk;
  onCopy: () => void;
  copied: boolean;
  t: (k: string) => string;
  variant?: LogPanelVariant;
}) {
  const showMissing = !chunk.exists;
  const headerMain =
    variant === 'tab' ? null : (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Terminal className="h-4 w-4" aria-hidden />
      </div>
    );

  return (
    <div
      className={[
        'flex min-h-0 min-w-0 flex-col overflow-hidden',
        variant === 'stacked'
          ? 'flex-1 rounded-2xl border border-slate-200/90 bg-white shadow-sm dark:border-slate-600/60 dark:bg-slate-900/40 dark:shadow-none'
          : 'h-full min-h-0',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div
        className={[
          'flex shrink-0 items-center justify-between gap-2 border-b border-slate-200/80 dark:border-slate-600/50',
          variant === 'stacked' ? 'px-3 py-2.5 sm:px-4' : 'px-2 py-2 sm:px-3',
        ].join(' ')}
      >
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {headerMain}
          <div className="min-w-0 flex-1">
            {variant === 'stacked' && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="truncate text-sm font-semibold text-slate-800 dark:text-slate-100">
                  {label}
                </span>
                {chunk.truncated && (
                  <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    {t('logs.truncated')}
                  </span>
                )}
              </div>
            )}
            {variant === 'tab' && chunk.truncated && (
              <div className="mb-0.5">
                <span className="rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                  {t('logs.truncated')}
                </span>
              </div>
            )}
            <Tooltip title={chunk.path}>
              <p
                className={[
                  'truncate text-slate-500 dark:text-slate-400',
                  variant === 'stacked' ? 'text-[11px]' : 'text-xs',
                ].join(' ')}
              >
                {chunk.path}
              </p>
            </Tooltip>
          </div>
        </div>
        <Button
          type="default"
          size="small"
          className="shrink-0"
          icon={copied ? <CheckOutlined className="text-emerald-500" /> : <CopyOutlined />}
          onClick={onCopy}
          disabled={showMissing && !chunk.text}
        >
          {t('logs.copyBlock')}
        </Button>
      </div>

      <div
        className={[
          'min-h-0 flex-1 bg-[#0b0f19] p-0 dark:bg-[#070a12]',
          variant === 'tab' && 'min-h-0',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        {showMissing && (
          <p className="px-3 py-2 text-sm text-amber-600/95 dark:text-amber-400/95">{t('logs.emptyFile')}</p>
        )}
        <div
          className={[
            'h-full min-h-0 overflow-auto px-3 py-3 sm:px-4',
            variant === 'stacked' && 'max-h-[min(58vh,560px)] min-h-[220px]',
            variant === 'tab' && 'min-h-0',
          ]
            .filter(Boolean)
            .join(' ')}
          style={{ scrollbarGutter: 'stable' }}
        >
          <RuntimeLogView
            text={chunk.text || (showMissing ? '' : t('logs.empty'))}
            aria-label={label}
            className="min-h-0"
          />
        </div>
      </div>
    </div>
  );
}

export default function Logs() {
  const { t } = useTranslation();
  const { addToast } = useAppStore();
  const [searchQuery, setSearchQuery] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [activeLogTab, setActiveLogTab] = useState<'nanobot' | 'console'>('nanobot');

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['runtime-logs', 'all', RUNTIME_LOG_MAX_LINES],
    queryFn: () => api.getRuntimeLogs('all', RUNTIME_LOG_MAX_LINES),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  const displayChunks = useMemo(() => {
    const chunks = data?.chunks ?? [];
    if (!searchQuery.trim()) return chunks;
    return chunks.map((c) => ({
      ...c,
      text: filterLines(c.text, searchQuery),
    }));
  }, [data?.chunks, searchQuery]);

  useEffect(() => {
    if (displayChunks.length === 0) return;
    const keys = new Set(displayChunks.map((c) => c.source));
    if (!keys.has(activeLogTab)) {
      const first = displayChunks[0]!.source;
      setActiveLogTab(first);
    }
  }, [displayChunks, activeLogTab]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      addToast({ type: 'error', message: t('logs.copyFailed') });
    }
  };

  return (
    <PageLayout>
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        <div className="flex shrink-0 flex-col gap-4">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
            <div className="max-w-2xl min-w-0">
              <h1 className="gradient-text text-2xl font-bold tracking-tight sm:text-3xl">
                {t('logs.title')}
              </h1>
              <p className="mt-1.5 text-sm leading-relaxed text-slate-500 dark:text-slate-400">
                {t('logs.subtitle')}
              </p>
            </div>
            <div className="flex w-full min-w-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:gap-3 lg:max-w-[min(100%,32rem)] lg:shrink-0 xl:max-w-[36rem]">
              <Input.Search
                allowClear
                placeholder={t('logs.searchPlaceholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="min-w-0 sm:flex-1"
              />
              <div className="flex shrink-0 items-center justify-start gap-3 sm:ms-auto sm:justify-end">
                <label className="mb-0 flex cursor-pointer items-center gap-2 text-sm leading-none text-slate-600 dark:text-slate-300">
                  <Switch checked={autoRefresh} onChange={setAutoRefresh} size="small" />
                  <span className="whitespace-nowrap">{t('logs.autoRefresh')}</span>
                </label>
                <Button
                  type="primary"
                  icon={<ReloadOutlined />}
                  loading={isFetching}
                  onClick={() => refetch()}
                  disabled={isLoading}
                  className="shadow-sm"
                >
                  {t('common.refresh')}
                </Button>
              </div>
            </div>
          </div>
        </div>

        {error && (
          <Alert
            type="error"
            showIcon
            className="shrink-0"
            message={t('logs.loadError', { error: formatQueryError(error) })}
          />
        )}

        <div className="min-h-0 flex-1 flex flex-col">
          {isLoading && !data && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-500 dark:border-slate-600">
              <FileText className="mb-2 h-10 w-10 opacity-40" />
              {t('common.loading')}
            </div>
          )}

          {!isLoading && displayChunks.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-slate-200 py-20 text-slate-500 dark:border-slate-600">
              <FileText className="mb-2 h-10 w-10 opacity-40" />
              {t('logs.empty')}
            </div>
          )}

          {displayChunks.length === 1 && (
            <LogPanel
              label={
                displayChunks[0]!.source === 'nanobot'
                  ? t('logs.sourceNanobot')
                  : t('logs.sourceConsole')
              }
              chunk={displayChunks[0]!}
              copied={copied === chunkKey(displayChunks[0]!)}
              onCopy={() => copyText(chunkKey(displayChunks[0]!), displayChunks[0]!.text || '')}
              t={t}
              variant="stacked"
            />
          )}

          {displayChunks.length > 1 && (
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-slate-200/90 bg-white shadow-sm dark:border-slate-600/60 dark:bg-slate-900/30 dark:shadow-none">
              <Tabs
                activeKey={activeLogTab}
                onChange={(key) => setActiveLogTab(key as 'nanobot' | 'console')}
                type="line"
                size="middle"
                className="logs-runtime-tabs text-slate-800 dark:text-slate-100 [&_.ant-tabs-nav::before]:border-slate-200/80 dark:[&_.ant-tabs-nav::before]:border-slate-600/50"
                items={displayChunks.map((chunk) => {
                  const k = chunkKey(chunk);
                  const label =
                    chunk.source === 'nanobot' ? t('logs.sourceNanobot') : t('logs.sourceConsole');
                  return {
                    key: k,
                    label: (
                      <span className="inline-flex max-w-[200px] items-center gap-1.5 sm:max-w-none">
                        <Terminal className="h-3.5 w-3.5 opacity-60" aria-hidden />
                        <span className="truncate">{label}</span>
                      </span>
                    ),
                    children: (
                      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
                        <LogPanel
                          label={label}
                          chunk={chunk}
                          copied={copied === k}
                          onCopy={() => copyText(k, chunk.text || '')}
                          t={t}
                          variant="tab"
                        />
                      </div>
                    ),
                  };
                })}
              />
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
