import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  Tag,
  Button,
  Typography,
  Empty,
  Input,
  Alert,
  Tooltip,
  Spin,
  Drawer,
  Segmented,
  Card,
  Divider,
} from 'antd';
import {
  ReloadOutlined,
  HeartOutlined,
  InfoCircleOutlined,
  RightOutlined,
  DownOutlined,
  TagsOutlined,
  BarChartOutlined,
  WarningOutlined,
  CommentOutlined,
  SearchOutlined,
} from '@ant-design/icons';
import * as api from '../api/client';
import { formatQueryError } from '../utils/errors';
import { useAppStore } from '../store';
import { PageLayout } from '../components/PageLayout';
import { TraceGanttChart } from '../components/TraceGanttChart';
import type { AgentObservabilityEvent } from '../api/types';
import {
  classifyRunType,
  isErrorLikeEvent,
  observabilityRowKey,
  runTypeLabelKey,
  runTypeTagClass,
  runTypeAccentClass,
} from '../utils/observabilityRunType';

const { Text } = Typography;

function formatEventTimestamp(rawTs: number, locale: string): string {
  const ms = typeof rawTs === 'number' && rawTs < 1e12 ? rawTs * 1000 : Number(rawTs) || 0;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '—';
  const base = d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  return `${base}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function formatJsonPayload(p: Record<string, unknown> | undefined): string {
  if (!p || Object.keys(p).length === 0) return '—';
  try {
    return JSON.stringify(p, null, 2);
  } catch {
    return '—';
  }
}

type StreamStats = {
  total: number;
  uniqueTraces: number;
  errorLike: number;
  uniqueSessions: number;
};

function computeStreamStats(events: AgentObservabilityEvent[]): StreamStats {
  const traceIds = new Set<string>();
  const sessionKeys = new Set<string>();
  let errorLike = 0;
  for (const ev of events) {
    if (isErrorLikeEvent(ev.event)) errorLike += 1;
    if (ev.trace_id) traceIds.add(ev.trace_id);
    if (ev.session_key) sessionKeys.add(ev.session_key);
  }
  return {
    total: events.length,
    uniqueTraces: traceIds.size,
    errorLike,
    uniqueSessions: sessionKeys.size,
  };
}

type StatPill = { label: string; value: number | null; icon: ReactNode; warn?: boolean };

function useRelativeAgoString(t: (k: string, o?: Record<string, string | number>) => string, updatedAtMs: number) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((x) => x + 1), 2000);
    return () => clearInterval(id);
  }, []);
  // tick drives periodic relative-time refresh; intentionally listed for memo invalidation
  return useMemo(() => {
    const s = Math.max(0, Math.floor((Date.now() - updatedAtMs) / 1000));
    if (s < 2) return t('observability.lastUpdatedJustNow');
    if (s < 60) return t('observability.lastUpdatedAgo', { n: s });
    const m = Math.floor(s / 60);
    if (m < 120) return t('observability.lastUpdatedAgoMin', { n: m });
    return t('observability.lastUpdatedAgoLong');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- tick
  }, [t, updatedAtMs, tick]);
}

type TraceGroup = {
  groupKey: string;
  traceId: string | null;
  events: AgentObservabilityEvent[];
};

/** Preserve API order, one block per distinct trace_id; events without id each form a singleton group. */
function buildTraceGroups(events: AgentObservabilityEvent[]): TraceGroup[] {
  const order: string[] = [];
  const map = new Map<string, TraceGroup>();
  for (const ev of events) {
    const tid = ev.trace_id?.trim() || null;
    const gk = tid ? `t:${tid}` : `o:${observabilityRowKey(ev)}`;
    if (!map.has(gk)) {
      order.push(gk);
      map.set(gk, { groupKey: gk, traceId: tid, events: [] });
    }
    map.get(gk)!.events.push(ev);
  }
  return order.map((k) => map.get(k)!);
}

type SessionGroup = {
  key: string;
  sessionKey: string | null;
  traces: TraceGroup[];
  eventCount: number;
};

function buildSessionGroups(events: AgentObservabilityEvent[]): SessionGroup[] {
  const order: string[] = [];
  const bySession = new Map<string, AgentObservabilityEvent[]>();
  for (const ev of events) {
    const sk = (ev.session_key && String(ev.session_key).trim()) || '';
    const k = sk ? `s:${sk}` : 's:__no_session__';
    if (!bySession.has(k)) {
      order.push(k);
      bySession.set(k, []);
    }
    bySession.get(k)!.push(ev);
  }
  return order.map((k) => {
    const list = bySession.get(k)!;
    const sessionKey = k === 's:__no_session__' ? null : k.slice(2);
    return {
      key: k,
      sessionKey,
      traces: buildTraceGroups(list),
      eventCount: list.length,
    };
  });
}

function traceSectionKey(sessionKey: string, traceGroupKey: string): string {
  return `${sessionKey}::${traceGroupKey}`;
}

type EventRowProps = {
  ev: AgentObservabilityEvent;
  dateLocale: string;
  t: (k: string, o?: Record<string, string | number>) => string;
  onOpenDetail: (e: AgentObservabilityEvent) => void;
  /** false when trace is shown on the group header */
  showTraceIdColumn: boolean;
};

function ObservabilityEventRow({ ev, dateLocale, t, onOpenDetail, showTraceIdColumn }: EventRowProps) {
  const rt = classifyRunType(ev.event);
  const accent = runTypeAccentClass(rt);
  const err = isErrorLikeEvent(ev.event);
  const statusOk = !err;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onOpenDetail(ev)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpenDetail(ev);
        }
      }}
      className="flex min-w-0 cursor-pointer gap-0 outline-none transition-colors hover:bg-slate-50/95 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500/50 dark:hover:bg-slate-800/40"
    >
      <div className={`w-1 shrink-0 self-stretch ${accent}`} aria-hidden />
      <div className="min-w-0 flex-1 py-2.5 pl-2 pr-3 sm:pl-3">
        <div className="min-[800px]:hidden">
          <div className="flex flex-wrap items-center gap-2">
            <Text className="!m-0 font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {formatEventTimestamp(ev.ts, dateLocale)}
            </Text>
            <span
              className={`inline-flex max-w-[11rem] truncate rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wide ${runTypeTagClass(rt)}`}
            >
              {t(runTypeLabelKey(rt))}
            </span>
            <Tag
              className="m-0 !mr-0 border-0 !px-1.5 !text-[10px] font-medium"
              color={statusOk ? 'success' : 'error'}
            >
              {statusOk ? t('observability.statusSuccess') : t('observability.statusError')}
            </Tag>
          </div>
          <div className="mt-1.5 break-all font-mono text-xs text-slate-800 dark:text-slate-200">
            {ev.event}
          </div>
          {showTraceIdColumn && (
            <div
              className="mt-1.5 text-xs"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Text type="secondary" className="!text-xs">
                {t('observability.colTraceId')}{' '}
              </Text>
              {ev.trace_id ? (
                <Text code copyable className="!text-[11px]">
                  {ev.trace_id}
                </Text>
              ) : (
                '—'
              )}
            </div>
          )}
        </div>
        <div className="hidden min-[800px]:grid min-[800px]:grid-cols-[10rem_5.5rem_1fr_5.5rem_minmax(0,0.9fr)_minmax(0,0.7fr)] min-[800px]:items-center min-[800px]:gap-2 min-[800px]:gap-y-0">
          <Text className="!m-0 min-w-0 font-mono text-xs text-slate-500 dark:text-slate-400">
            {formatEventTimestamp(ev.ts, dateLocale)}
          </Text>
          <div className="min-w-0">
            <span
              className={`inline-flex w-full max-w-full truncate rounded border px-1.5 py-0.5 text-center font-mono text-[10px] font-semibold uppercase tracking-wide ${runTypeTagClass(rt)}`}
              title={t(runTypeLabelKey(rt))}
            >
              {t(runTypeLabelKey(rt))}
            </span>
          </div>
          <div
            className="min-w-0 truncate font-mono text-sm text-slate-800 dark:text-slate-100"
            title={ev.event}
          >
            {ev.event}
          </div>
          <div>
            <Tag
              className="m-0 !border-0 !px-1.5 !text-[10px] font-medium"
              color={statusOk ? 'success' : 'error'}
            >
              {statusOk ? t('observability.statusSuccess') : t('observability.statusError')}
            </Tag>
          </div>
          <div
            className="min-w-0"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            title={!showTraceIdColumn ? t('observability.groupTraceInHeader') : undefined}
          >
            {showTraceIdColumn && ev.trace_id ? (
              <Text
                code
                copyable
                className="!text-[11px] !text-slate-700 dark:!text-slate-200"
                ellipsis
              >
                {ev.trace_id}
              </Text>
            ) : showTraceIdColumn ? (
              <span className="text-slate-400">—</span>
            ) : (
              <span className="text-slate-300 dark:text-slate-600">·</span>
            )}
          </div>
          <div
            className="min-w-0 truncate text-xs text-slate-600 dark:text-slate-300"
            title={ev.session_key ?? undefined}
          >
            {ev.session_key ?? '—'}
          </div>
        </div>
        {Object.keys(ev.payload ?? {}).length > 0 && (
          <div className="mt-1 min-[800px]:mt-1.5">
            <Text className="!text-xs text-indigo-600 dark:!text-indigo-400">
              <RightOutlined aria-hidden />
              {t('observability.detailInputOutput')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Observability({ embedded = false }: { embedded?: boolean } = {}) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { currentBotId } = useAppStore();
  const [traceIdFilter, setTraceIdFilter] = useState('');

  useEffect(() => {
    const tid = searchParams.get('trace_id')?.trim();
    if (tid) setTraceIdFilter(tid);
  }, [searchParams]);
  const [runFilter, setRunFilter] = useState<'all' | 'error'>('all');
  const [detailEvent, setDetailEvent] = useState<AgentObservabilityEvent | null>(null);
  /** session key: collapsed session hides nested traces (default: all expanded) */
  const [collapsedSessions, setCollapsedSessions] = useState<Set<string>>(() => new Set());
  /** trace section key: present = expanded; absent = collapsed (default: all traces collapsed) */
  const [expandedTraces, setExpandedTraces] = useState<Set<string>>(() => new Set());

  const {
    data: timeline,
    isLoading: timelineLoading,
    isFetching: timelineFetching,
    error: timelineError,
    refetch: refetchTimeline,
    dataUpdatedAt,
  } = useQuery({
    queryKey: ['observability-timeline', currentBotId, traceIdFilter.trim() || ''],
    queryFn: () =>
      api.getObservabilityTimeline(currentBotId, {
        limit: 200,
        traceId: traceIdFilter.trim() || null,
      }),
  });

  const lastUpdatedAgo = useRelativeAgoString(t, dataUpdatedAt || Date.now());
  const dateLocale = i18n.language?.startsWith('zh') ? 'zh-CN' : i18n.language || 'en-US';
  const events = useMemo(() => (timeline?.ok ? timeline.events : []), [timeline]);
  const stats = useMemo(() => computeStreamStats(events), [events]);

  const displayedEvents = useMemo(() => {
    if (runFilter === 'error') {
      return events.filter((e) => isErrorLikeEvent(e.event));
    }
    return events;
  }, [events, runFilter]);

  const sessionGroups = useMemo(() => buildSessionGroups(displayedEvents), [displayedEvents]);
  const namedTraceCount = useMemo(
    () => sessionGroups.reduce((a, s) => a + s.traces.filter((g) => g.traceId != null).length, 0),
    [sessionGroups],
  );
  const sessionCount = sessionGroups.length;

  const toggleSession = (sessionK: string) => {
    setCollapsedSessions((prev) => {
      const n = new Set(prev);
      if (n.has(sessionK)) n.delete(sessionK);
      else n.add(sessionK);
      return n;
    });
  };

  const toggleTrace = (sectionKey: string) => {
    setExpandedTraces((prev) => {
      const n = new Set(prev);
      if (n.has(sectionKey)) n.delete(sectionKey);
      else n.add(sectionKey);
      return n;
    });
  };

  const hasTimelineData = Boolean(timeline?.ok && events.length > 0);
  const hasFilteredView = hasTimelineData && displayedEvents.length > 0;
  const isEmptyWithFilter = hasTimelineData && runFilter === 'error' && displayedEvents.length === 0;

  const statPills: StatPill[] = [
    {
      label: t('observability.statTotalEvents'),
      value: hasTimelineData ? stats.total : null,
      icon: <BarChartOutlined className="text-slate-500" />,
    },
    {
      label: t('observability.statUniqueTraces'),
      value: hasTimelineData ? stats.uniqueTraces : null,
      icon: <TagsOutlined className="text-slate-500" />,
    },
    {
      label: t('observability.statErrorEvents'),
      value: hasTimelineData ? stats.errorLike : null,
      icon: <WarningOutlined className="text-rose-500" />,
      warn: hasTimelineData && stats.errorLike > 0,
    },
    {
      label: t('observability.statActiveSessions'),
      value: hasTimelineData ? stats.uniqueSessions : null,
      icon: <CommentOutlined className="text-slate-500" />,
    },
  ];

  const helpTooltip = (
    <div className="max-w-sm space-y-2 text-xs">
      <p className="m-0">{t('observability.pageTagline')}</p>
      <p className="m-0">{t('observability.groupBySessionHint')}</p>
      <p className="m-0 opacity-90">{t('observability.subtitle')}</p>
    </div>
  );

  return (
    <PageLayout variant="bleed" embedded={embedded} className="min-h-0">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <h1 className="bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-2xl font-bold text-transparent dark:from-white dark:to-gray-300">
              {t('observability.title')}
            </h1>
          </div>
          <div className="flex min-w-0 shrink-0 flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-0">
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1.5 sm:mr-1">
              <Tooltip
                title={
                  <div className="max-w-xs space-y-1.5 text-xs">
                    {statPills.map((p) => (
                      <div key={p.label} className="flex items-center gap-2">
                        <span className="shrink-0 opacity-80">{p.icon}</span>
                        <span className="min-w-0 flex-1">{p.label}</span>
                        <span
                          className={`font-mono tabular-nums ${
                            p.warn && hasTimelineData && (p.value ?? 0) > 0 ? 'text-rose-500' : ''
                          }`}
                        >
                          {timelineLoading ? '…' : p.value === null ? '—' : p.value}
                        </span>
                      </div>
                    ))}
                  </div>
                }
              >
                <Tag
                  className={`m-0 cursor-help border-gray-200 bg-gray-50/90 font-mono text-xs tabular-nums dark:border-gray-600 dark:bg-gray-800/50 ${
                    hasTimelineData && stats.errorLike > 0
                      ? '!border-rose-200 !text-rose-700 dark:!border-rose-800 dark:!text-rose-300'
                      : ''
                  }`}
                >
                  {timelineLoading
                    ? '…'
                    : !hasTimelineData
                      ? '—'
                      : `${stats.total}·${stats.uniqueTraces}·${stats.errorLike}·${stats.uniqueSessions}`}
                </Tag>
              </Tooltip>
              <Tooltip title={`${t('observability.lastUpdated')}: ${lastUpdatedAgo}`}>
                <Text type="secondary" className="!text-xs !leading-none whitespace-nowrap">
                  {lastUpdatedAgo}
                  {timelineFetching && <span className="ml-0.5 text-indigo-500">…</span>}
                </Text>
              </Tooltip>
            </div>
            <Divider type="vertical" className="!mx-0 !my-0 !hidden !h-7 sm:!inline-flex sm:!items-center" />
            <div className="flex items-center justify-end gap-1 border-t border-gray-200/90 pt-2 dark:border-gray-600/80 sm:border-t-0 sm:pt-0">
              <Tooltip title={helpTooltip}>
                <Button
                  type="text"
                  size="small"
                  icon={<InfoCircleOutlined />}
                  aria-label={t('observability.subtitle')}
                />
              </Tooltip>
              <Tooltip title={t('observability.linkHealth')}>
                <Button
                  size="small"
                  icon={<HeartOutlined />}
                  onClick={() => navigate('/observability?section=health')}
                  aria-label={t('observability.linkHealth')}
                >
                  <span className="hidden md:inline">{t('observability.linkHealth')}</span>
                </Button>
              </Tooltip>
              <Button
                type="primary"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void refetchTimeline()}
                aria-label={t('common.refresh')}
              >
                <span className="hidden sm:inline">{t('common.refresh')}</span>
              </Button>
            </div>
          </div>
        </div>

        <Card
          className="mt-4 flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-gray-200/90 shadow-sm dark:border-gray-700/80 dark:bg-gray-800/35"
          styles={{
            body: { padding: 0, display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 },
          }}
        >
          <div
            className="shrink-0 border-b border-gray-100 bg-gray-50/40 px-4 py-3 dark:border-gray-700 dark:bg-gray-800/20"
            role="search"
            aria-label={t('observability.filterBarAria')}
          >
            {timeline && !timeline.ok && timeline.error && !timelineError && (
              <Alert
                type="warning"
                className="mb-3 rounded py-1.5 text-sm"
                title={t('observability.timelineSourceError')}
                description={timeline.error}
                showIcon
              />
            )}
            {timelineError && (
              <Alert
                type="warning"
                className="mb-3 rounded py-1.5"
                title={t('observability.timelineError')}
                description={formatQueryError(timelineError)}
                showIcon
              />
            )}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <Segmented
                className="min-w-max"
                value={runFilter}
                onChange={(v) => setRunFilter(v as 'all' | 'error')}
                options={[
                  { label: t('observability.filterAllRuns'), value: 'all' },
                  { label: t('observability.filterErrorRuns'), value: 'error' },
                ]}
              />
              <div className="w-full min-w-0 sm:max-w-[280px] sm:shrink-0">
                <Input
                  allowClear
                  size="large"
                  placeholder={t('observability.traceIdFilterPlaceholder')}
                  value={traceIdFilter}
                  onChange={(e) => setTraceIdFilter(e.target.value)}
                  onPressEnter={() => void refetchTimeline()}
                  prefix={<SearchOutlined className="text-gray-400" aria-hidden />}
                  className="!w-full !rounded font-mono text-sm dark:!bg-gray-950/50"
                />
              </div>
            </div>
          </div>

          <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
            <div className="flex shrink-0 items-center justify-between border-b border-gray-100 bg-gray-50/80 px-4 py-2 dark:border-gray-700 dark:bg-gray-900/50">
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.1em] text-gray-500 dark:text-gray-400">
                  {t('observability.breadcrumbTraces')}
                </span>
                <span className="hidden text-gray-200 dark:text-gray-600 sm:inline">|</span>
                <span className="hidden truncate text-xs text-gray-500 dark:text-gray-500 sm:inline">
                  {t('observability.groupBySessionHint')}
                </span>
              </div>
              <div className="shrink-0 text-right">
                <span className="font-mono text-[11px] text-gray-500 dark:text-gray-500">
                  {t('observability.listSummary', {
                    events: displayedEvents.length,
                    traces: namedTraceCount,
                    sessions: sessionCount,
                  })}
                </span>
              </div>
            </div>

            {timelineLoading && events.length === 0 && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white/70 dark:bg-zinc-950/50">
                <Spin size="large" />
              </div>
            )}

            {hasFilteredView && (
              <div className="min-h-0 flex-1 overflow-y-auto">
                <ul className="m-0 list-none p-0">
                  {sessionGroups.map((sg) => {
                    const sessionOpen = !collapsedSessions.has(sg.key);
                    return (
                      <li
                        key={sg.key}
                        className="border-b border-slate-200/90 last:border-b-0 dark:border-slate-800/50"
                      >
                        <div
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleSession(sg.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              toggleSession(sg.key);
                            }
                          }}
                          aria-expanded={sessionOpen}
                          className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 border-b border-cyan-200/40 bg-gradient-to-r from-cyan-50/90 to-slate-50/90 px-2 py-2.5 text-left dark:border-cyan-900/30 dark:from-cyan-950/25 dark:to-slate-900/40 sm:gap-3 sm:px-3"
                        >
                          <span className="shrink-0 text-slate-500" title={sessionOpen ? t('observability.groupToggleCollapse') : t('observability.groupToggleExpand')}>
                            {sessionOpen ? <DownOutlined /> : <RightOutlined />}
                          </span>
                          <CommentOutlined className="shrink-0 text-cyan-600 dark:text-cyan-400" />
                          <div
                            className="min-w-0 flex-1 font-mono text-xs text-slate-800 dark:text-slate-200"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {sg.sessionKey != null ? (
                              <Text code copyable className="!text-[12px] sm:!text-xs" ellipsis>
                                {sg.sessionKey}
                              </Text>
                            ) : (
                              <span className="text-slate-500 dark:text-slate-400">
                                {t('observability.groupNoSession')}
                              </span>
                            )}
                          </div>
                          <span className="hidden shrink-0 sm:inline">
                            <Tag className="m-0 !border-cyan-200/60 !px-1.5 !text-[10px] dark:!border-cyan-800/50">
                              {t('observability.sessionMeta', {
                                traces: sg.traces.length,
                                evs: sg.eventCount,
                              })}
                            </Tag>
                          </span>
                        </div>
                        {sessionOpen && (
                          <ul className="m-0 list-none border-l-2 border-cyan-200/50 pl-0 dark:border-cyan-900/30 sm:ml-1 sm:pl-0">
                            {sg.traces.map((g) => {
                              const sectionKey = traceSectionKey(sg.key, g.groupKey);
                              const traceOpen = expandedTraces.has(sectionKey);
                              if (g.traceId == null) {
                                const ev = g.events[0]!;
                                return (
                                  <li
                                    key={g.groupKey}
                                    className="border-b border-slate-200/60 last:border-b-0 dark:border-slate-800/50"
                                  >
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      onClick={() => toggleTrace(sectionKey)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter' || e.key === ' ') {
                                          e.preventDefault();
                                          toggleTrace(sectionKey);
                                        }
                                      }}
                                      aria-expanded={traceOpen}
                                      className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 bg-slate-50/50 px-2 py-2 pl-1 dark:bg-slate-800/20 sm:pl-2"
                                    >
                                      <span className="shrink-0 text-slate-400">
                                        {traceOpen ? <DownOutlined /> : <RightOutlined />}
                                      </span>
                                      <TagsOutlined className="shrink-0 text-slate-500" />
                                      <span className="min-w-0 flex-1 text-left text-xs text-slate-500 dark:text-slate-400">
                                        {t('observability.groupNoTrace')}
                                      </span>
                                      <Tag className="m-0 !text-[9px]">{t('observability.groupSpanCount', { count: 1 })}</Tag>
                                    </div>
                                    {traceOpen && (
                                      <div>
                                        <TraceGanttChart events={g.events} t={t} onSelectEvent={setDetailEvent} dateLocale={dateLocale} />
                                        <ul className="m-0 list-none p-0">
                                          <li className="border-b border-slate-100/80 dark:border-slate-800/50">
                                            <ObservabilityEventRow
                                              ev={ev}
                                              dateLocale={dateLocale}
                                              t={t}
                                              onOpenDetail={setDetailEvent}
                                              showTraceIdColumn
                                            />
                                          </li>
                                        </ul>
                                      </div>
                                    )}
                                  </li>
                                );
                              }
                              return (
                                <li
                                  key={g.groupKey}
                                  className="border-b border-slate-200/60 last:border-b-0 dark:border-slate-800/50"
                                >
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={() => toggleTrace(sectionKey)}
                                    onKeyDown={(e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        toggleTrace(sectionKey);
                                      }
                                    }}
                                    aria-expanded={traceOpen}
                                    className="flex w-full min-w-0 cursor-pointer select-none items-center gap-2 border-b border-slate-100/80 bg-slate-50/80 px-2 py-2 pl-1 dark:border-slate-800/50 dark:bg-slate-800/25 sm:gap-2 sm:pl-2"
                                  >
                                    <span className="shrink-0 text-slate-400">
                                      {traceOpen ? <DownOutlined /> : <RightOutlined />}
                                    </span>
                                    <TagsOutlined className="shrink-0 text-indigo-500 dark:text-indigo-400" />
                                    <div
                                      className="min-w-0 flex-1"
                                      onClick={(e) => e.stopPropagation()}
                                      onKeyDown={(e) => e.stopPropagation()}
                                    >
                                      <Text code copyable className="!text-[12px] sm:!text-xs" ellipsis>
                                        {g.traceId}
                                      </Text>
                                    </div>
                                    <span className="hidden sm:inline">
                                      <Tag className="m-0 !border-slate-200/90 !px-1.5 !text-[10px] dark:!border-slate-600">
                                        {t('observability.groupSpanCount', { count: g.events.length })}
                                      </Tag>
                                    </span>
                                  </div>
                                  {traceOpen && (
                                    <div>
                                      <TraceGanttChart events={g.events} t={t} onSelectEvent={setDetailEvent} dateLocale={dateLocale} />
                                      <div className="hidden min-[800px]:grid min-[800px]:grid-cols-[10rem_5.5rem_1fr_5.5rem_minmax(0,0.9fr)_minmax(0,0.7fr)] min-[800px]:items-center min-[800px]:gap-2 min-[800px]:border-b min-[800px]:border-slate-200/80 min-[800px]:bg-slate-50/95 min-[800px]:px-4 min-[800px]:py-2 min-[800px]:text-[10px] min-[800px]:font-semibold min-[800px]:uppercase min-[800px]:tracking-wider min-[800px]:text-slate-500 dark:border-slate-800 dark:bg-slate-900/50 dark:text-slate-500">
                                        <span>{t('observability.colTime')}</span>
                                        <span>{t('observability.colRunType')}</span>
                                        <span className="min-w-0">{t('observability.colRunName')}</span>
                                        <span>{t('observability.colStatus')}</span>
                                        <span className="min-w-0">{t('observability.colTraceId')}</span>
                                        <span className="min-w-0">{t('observability.colSession')}</span>
                                      </div>
                                      <ul className="m-0 list-none p-0">
                                        {g.events.map((ev) => {
                                          const rkey = observabilityRowKey(ev);
                                          return (
                                            <li
                                              key={rkey}
                                              className="border-b border-slate-100/80 last:border-b-0 dark:border-slate-800/50"
                                            >
                                              <div className="border-l-2 border-indigo-200/80 pl-0 dark:border-indigo-500/40 sm:pl-1 sm:ml-1">
                                                <ObservabilityEventRow
                                                  ev={ev}
                                                  dateLocale={dateLocale}
                                                  t={t}
                                                  onOpenDetail={setDetailEvent}
                                                  showTraceIdColumn={false}
                                                />
                                              </div>
                                            </li>
                                          );
                                        })}
                                      </ul>
                                    </div>
                                  )}
                                </li>
                              );
                            })}
                          </ul>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            {isEmptyWithFilter && (
              <div className="flex min-h-[14rem] flex-1 items-center justify-center p-6">
                <Empty description={t('observability.emptyFiltered')} />
              </div>
            )}

            {timeline && timeline.ok && events.length === 0 && !timelineError && !timelineLoading && (
              <div className="flex min-h-[14rem] flex-1 items-center justify-center p-6">
                <Empty description={t('observability.timelineEmpty')} />
              </div>
            )}
          </div>
        </Card>
      </div>

      <Drawer
        title={t('observability.detailDrawerTitle')}
        width={Math.min(560, typeof window !== 'undefined' ? window.innerWidth - 24 : 560)}
        open={Boolean(detailEvent)}
        onClose={() => setDetailEvent(null)}
        classNames={{ body: '!p-0' }}
      >
        {detailEvent && (
          <div className="flex h-full min-h-0 flex-col p-4">
            <div className="shrink-0 space-y-2 border-b border-slate-100 pb-3 dark:border-slate-800">
              <Text className="!block !text-sm font-medium text-slate-900 dark:text-slate-100">
                {detailEvent.event}
              </Text>
              <div className="grid gap-1.5 text-xs text-slate-500 dark:text-slate-400">
                <div>
                  <span className="text-slate-400">{t('observability.colTime')}: </span>
                  {formatEventTimestamp(detailEvent.ts, dateLocale)}
                </div>
                <div>
                  <span className="text-slate-400">{t('observability.colRunType')}: </span>
                  {t(runTypeLabelKey(classifyRunType(detailEvent.event)))}
                </div>
                {detailEvent.trace_id && (
                  <div
                    onClick={(e) => e.stopPropagation()}
                    className="break-all"
                  >
                    <span className="text-slate-400">{t('observability.colTraceId')}: </span>
                    <Text code copyable>
                      {detailEvent.trace_id}
                    </Text>
                  </div>
                )}
                {detailEvent.session_key && (
                  <div className="break-all">
                    <span className="text-slate-400">{t('observability.colSession')}: </span>
                    {detailEvent.session_key}
                  </div>
                )}
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden pt-3">
              <Text type="secondary" className="!mb-2 !block text-[11px] uppercase tracking-wide">
                {t('observability.detailInputOutput')}
              </Text>
              <pre className="h-full max-h-[calc(100vh-12rem)] overflow-auto rounded border border-slate-200/90 bg-slate-950/90 p-3 font-mono text-[11px] leading-relaxed text-slate-100 dark:border-slate-700">
                {formatJsonPayload(detailEvent.payload)}
              </pre>
            </div>
          </div>
        )}
      </Drawer>
    </PageLayout>
  );
}
