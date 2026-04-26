import { useEffect, useMemo, useRef, useState, type UIEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Input, Switch, Tooltip } from 'antd';
import {
  CopyOutlined,
  CheckOutlined,
  ReloadOutlined,
  DeleteOutlined,
  VerticalAlignTopOutlined,
  VerticalAlignBottomOutlined,
} from '@ant-design/icons';
import { FileText, Terminal } from 'lucide-react';
import { useAppStore } from '../store';
import * as api from '../api/client';
import { PageLayout } from '../components/PageLayout';
import { RuntimeLogView } from '../components/RuntimeLogView';
import { formatQueryError } from '../utils/errors';
import type { RuntimeLogChunk } from '../api/types';

/** Lazy loading: start shallow, then expand on demand. */
const RUNTIME_LOG_INITIAL_LINES = 300;
const RUNTIME_LOG_LOAD_STEP = 300;

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
  searchQuery,
  onSearchChange,
  onCopy,
  onBodyScroll,
  copied,
  t,
  variant = 'stacked',
}: {
  label: string;
  chunk: RuntimeLogChunk;
  searchQuery: string;
  onSearchChange: (value: string) => void;
  onCopy: () => void;
  onBodyScroll?: (e: UIEvent<HTMLDivElement>) => void;
  copied: boolean;
  t: (k: string) => string;
  variant?: LogPanelVariant;
}) {
  const showMissing = !chunk.exists;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const headerMain =
    variant === 'tab' ? null : (
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
        <Terminal className="h-4 w-4" aria-hidden />
      </div>
    );

  const scrollToTop = () => {
    bodyRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const scrollToBottom = () => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div
      className={[
        'flex min-h-0 min-w-0 flex-col overflow-hidden',
        variant === 'stacked'
          ? 'flex-1 rounded-md border border-slate-200/90 bg-white shadow-sm dark:border-slate-600/60 dark:bg-slate-900/40 dark:shadow-none'
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
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
                    {t('logs.truncated')}
                  </span>
                )}
              </div>
            )}
            {variant === 'tab' && chunk.truncated && (
              <div className="mb-0.5">
                <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-400">
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
        <div className="flex shrink-0 items-center gap-2">
          <Input.Search
            allowClear
            size="middle"
            placeholder={t('logs.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-[220px] min-w-[180px]"
          />
          <Tooltip title={t('logs.scrollTop')}>
            <Button
              type="default"
              size="middle"
              className="shrink-0"
              icon={<VerticalAlignTopOutlined />}
              onClick={scrollToTop}
              aria-label={t('logs.scrollTop')}
            />
          </Tooltip>
          <Tooltip title={t('logs.scrollBottom')}>
            <Button
              type="default"
              size="middle"
              className="shrink-0"
              icon={<VerticalAlignBottomOutlined />}
              onClick={scrollToBottom}
              aria-label={t('logs.scrollBottom')}
            />
          </Tooltip>
          <Button
            type="default"
            size="middle"
            className="shrink-0"
            icon={copied ? <CheckOutlined className="text-emerald-500" /> : <CopyOutlined />}
            onClick={onCopy}
            disabled={showMissing && !chunk.text}
          >
            {t('logs.copyBlock')}
          </Button>
        </div>
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
          onScroll={onBodyScroll}
          ref={bodyRef}
        >
          <RuntimeLogView
            text={chunk.text || (showMissing ? '' : t('logs.empty'))}
            newestFirst
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
  const [isClearing, setIsClearing] = useState(false);
  const [mergedChunk, setMergedChunk] = useState<RuntimeLogChunk | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isFetchingOlder, setIsFetchingOlder] = useState(false);
  const autoLoadLockedRef = useRef(false);
  const lastScrollTopRef = useRef(0);
  const lastAutoLoadAtRef = useRef(0);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['runtime-logs', 'all', 'first-page', RUNTIME_LOG_INITIAL_LINES],
    queryFn: () => api.getRuntimeLogs('all', { limit: RUNTIME_LOG_INITIAL_LINES }),
    refetchInterval: autoRefresh ? 5000 : false,
  });

  useEffect(() => {
    const first = data?.chunks?.[0];
    if (!first) {
      setMergedChunk(null);
      setNextCursor(null);
      return;
    }
    setMergedChunk(first);
    setNextCursor(first.next_cursor ?? null);
  }, [data]);

  const displayChunks = useMemo(() => {
    if (!mergedChunk) return [];
    if (!searchQuery.trim()) return [mergedChunk];
    return [{ ...mergedChunk, text: filterLines(mergedChunk.text, searchQuery) }];
  }, [mergedChunk, searchQuery]);

  const copyText = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    } catch {
      addToast({ type: 'error', message: t('logs.copyFailed') });
    }
  };

  const clearLogs = async () => {
    setIsClearing(true);
    try {
      await api.clearRuntimeLogs();
      addToast({ type: 'success', message: t('logs.clearSuccess') });
      setMergedChunk(null);
      setNextCursor(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast({ type: 'error', message: t('logs.clearFailed', { error: message }) });
    } finally {
      setIsClearing(false);
    }
  };

  const canLoadMore = nextCursor != null;

  const loadMore = async () => {
    if (!nextCursor || isFetchingOlder) return;
    setIsFetchingOlder(true);
    try {
      const older = await api.getRuntimeLogs('all', {
        limit: RUNTIME_LOG_LOAD_STEP,
        cursor: nextCursor,
      });
      const olderChunk = older.chunks?.[0];
      if (!olderChunk) return;
      setMergedChunk((prev) => {
        if (!prev) return olderChunk;
        // Older page goes before current text so chronological order stays stable.
        return {
          ...prev,
          text: `${olderChunk.text}${prev.text}`,
          truncated: olderChunk.has_more,
          has_more: olderChunk.has_more,
          next_cursor: olderChunk.next_cursor ?? null,
        };
      });
      setNextCursor(olderChunk.next_cursor ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast({ type: 'error', message: t('logs.loadError', { error: message }) });
    } finally {
      setIsFetchingOlder(false);
    }
  };

  useEffect(() => {
    if (!isFetching && !isFetchingOlder) {
      autoLoadLockedRef.current = false;
    }
  }, [isFetching, isFetchingOlder]);

  const handleLogBodyScroll = (e: UIEvent<HTMLDivElement>) => {
    if (!canLoadMore || isFetching || isFetchingOlder || autoLoadLockedRef.current) return;
    const el = e.currentTarget;
    const now = Date.now();
    const currentTop = el.scrollTop;
    const movingDown = currentTop > lastScrollTopRef.current + 2;
    lastScrollTopRef.current = currentTop;
    if (!movingDown) return;
    // Throttle auto-loads so one continuous scroll does not burst multiple pages.
    if (now - lastAutoLoadAtRef.current < 500) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceToBottom > 80) return;
    autoLoadLockedRef.current = true;
    lastAutoLoadAtRef.current = now;
    void loadMore();
  };

  return (
    <PageLayout>
      <div className="flex min-h-0 flex-1 flex-col gap-5 [&_.ant-input-affix-wrapper]:!rounded-md [&_.ant-btn]:!rounded-md [&_.ant-alert]:!rounded-md">
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
              <div className="flex shrink-0 items-center justify-start gap-3 sm:ms-auto sm:justify-end">
                <label className="mb-0 flex cursor-pointer items-center gap-2 text-sm leading-none text-slate-600 dark:text-slate-300">
                  <Switch checked={autoRefresh} onChange={setAutoRefresh} size="small" />
                  <span className="whitespace-nowrap">{t('logs.autoRefresh')}</span>
                </label>
                <Button
                  danger
                  icon={<DeleteOutlined />}
                  loading={isClearing}
                  onClick={clearLogs}
                  disabled={isLoading}
                >
                  {t('logs.clear')}
                </Button>
                <Button
                  type="primary"
                  icon={<ReloadOutlined />}
                  loading={isFetching}
                  onClick={() => {
                    setMergedChunk(null);
                    setNextCursor(null);
                    void refetch();
                  }}
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
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-200 py-20 text-slate-500 dark:border-slate-600">
              <FileText className="mb-2 h-10 w-10 opacity-40" />
              {t('common.loading')}
            </div>
          )}

          {!isLoading && displayChunks.length === 0 && !error && (
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-slate-200 py-20 text-slate-500 dark:border-slate-600">
              <FileText className="mb-2 h-10 w-10 opacity-40" />
              {t('logs.empty')}
            </div>
          )}

          {displayChunks.length === 1 && (
            <LogPanel
              label={t('logs.sourceConsole')}
              chunk={displayChunks[0]!}
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
              copied={copied === chunkKey(displayChunks[0]!)}
              onCopy={() => copyText(chunkKey(displayChunks[0]!), displayChunks[0]!.text || '')}
              onBodyScroll={handleLogBodyScroll}
              t={t}
              variant="stacked"
            />
          )}

          {displayChunks.length > 1 && (
            <div className="flex min-h-0 flex-1 flex-col gap-3">
              {displayChunks.map((chunk) => {
                const k = chunkKey(chunk);
                return (
                  <LogPanel
                    key={k}
                    label={t('logs.sourceConsole')}
                    chunk={chunk}
                    searchQuery={searchQuery}
                    onSearchChange={setSearchQuery}
                    copied={copied === k}
                    onCopy={() => copyText(k, chunk.text || '')}
                    onBodyScroll={handleLogBodyScroll}
                    t={t}
                    variant="stacked"
                  />
                );
              })}
            </div>
          )}
          {isFetchingOlder && canLoadMore && (
            <div className="mt-3 text-center text-xs text-slate-500 dark:text-slate-400">
              {t('logs.loadingMore')}
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  );
}
