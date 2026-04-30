import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TFunction } from 'i18next';
import type { AgentObservabilityEvent } from '../api/types';
import { useAppStore } from '../store';
import {
  classifyRunType,
  type RunType,
  runTypeChartColor,
  runTypeLabelKey,
} from '../utils/observabilityRunType';

type Segment = { ev: AgentObservabilityEvent; startMs: number; endMs: number; rt: RunType };

function toTimestampMs(rawTs: number): number {
  if (typeof rawTs !== 'number' || Number.isNaN(rawTs)) return 0;
  return rawTs < 1e12 ? rawTs * 1000 : rawTs;
}

function buildSegments(events: AgentObservabilityEvent[]): Segment[] {
  if (events.length === 0) return [];
  const sorted = [...events].sort((a, b) => toTimestampMs(a.ts) - toTimestampMs(b.ts));
  return sorted.map((ev, i) => {
    const tEnd = toTimestampMs(ev.ts);
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    const wallMs = typeof p.wall_ms === 'number' && p.wall_ms > 0 ? p.wall_ms : null;
    const durMs = typeof p.duration_ms === 'number' && p.duration_ms > 0 ? p.duration_ms : null;
    const en = (ev.event || '').toLowerCase();
    const rt = classifyRunType(ev.event);

    let startMs: number;
    let endMs: number;

    if (wallMs != null) {
      endMs = tEnd;
      startMs = tEnd - wallMs;
    } else if (durMs != null && en !== 'run_start') {
      endMs = tEnd;
      startMs = tEnd - durMs;
    } else {
      startMs = tEnd;
      const next = sorted[i + 1];
      if (next) {
        const tNext = toTimestampMs(next.ts);
        const gap = tNext - tEnd;
        if (gap > 1) {
          endMs = tEnd + Math.min(200, Math.max(8, gap * 0.45));
        } else {
          endMs = tEnd + 40;
        }
      } else {
        endMs = tEnd + 64;
      }
    }

    if (startMs > endMs) {
      const x = startMs;
      startMs = endMs;
      endMs = x;
    }
    if (startMs < 0) {
      endMs -= startMs;
      startMs = 0;
    }
    return { ev, startMs, endMs, rt };
  });
}

const ROW_PX = 30;
const CHART_TOP_PAD = 6;
const LABEL_COL = 112;
const AXIS_BOTTOM = 22;
const PLOT_RIGHT = 10;
const PLOT_LEFT = 6;

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

function formatPayloadPreview(payload: Record<string, unknown> | undefined): string {
  if (!payload || Object.keys(payload).length === 0) return '—';
  try {
    const s = JSON.stringify(payload, null, 2);
    return s.length > 3500 ? `${s.slice(0, 3500)}\n…` : s;
  } catch {
    return '—';
  }
}

function useChartDarkMode(): boolean {
  const theme = useAppStore((s) => s.theme);
  const [mediaDark, setMediaDark] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : false,
  );
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setMediaDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return mediaDark;
}

type Props = {
  events: AgentObservabilityEvent[];
  t: TFunction;
  onSelectEvent: (e: AgentObservabilityEvent) => void;
  dateLocale: string;
};

type TipState = { idx: number; clientX: number; clientY: number };

function GanttTooltipPanel({
  segment,
  t,
  dateLocale,
  isDark,
}: {
  segment: Segment;
  t: TFunction;
  dateLocale: string;
  isDark: boolean;
}) {
  const ev = segment.ev;
  const rt = segment.rt;
  const barMs = segment.endMs - segment.startMs;
  const payloadText = formatPayloadPreview(ev.payload as Record<string, unknown>);
  const border = isDark ? 'rgba(148,163,184,.25)' : 'rgba(15,23,42,.1)';
  const preBg = isDark ? 'rgba(0,0,0,.35)' : 'rgba(241,245,249,.9)';

  return (
    <div
      className={`pointer-events-auto max-h-[min(70vh,22rem)] max-w-[min(90vw,22rem)] overflow-hidden rounded-lg border px-3 py-2 text-[11px] shadow-lg ${
        isDark
          ? 'border-slate-600 bg-slate-900/95 text-slate-100'
          : 'border-slate-200 bg-white/98 text-slate-900'
      }`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="mb-1.5 font-semibold leading-tight">{ev.event}</div>
      <div className="space-y-1 text-[11px] leading-snug opacity-90">
        <div>
          <span className="opacity-55">{t('observability.colTime')}</span>:{' '}
          {formatEventTimestamp(ev.ts, dateLocale)}
        </div>
        <div>
          <span className="opacity-55">{t('observability.colRunType')}</span>: {t(runTypeLabelKey(rt))}
        </div>
        <div>
          <span className="opacity-55">{t('observability.ganttTooltipBar')}</span>:{' '}
          {Math.max(0, Math.round(barMs))} ms
        </div>
        {ev.trace_id ? (
          <div className="break-all">
            <span className="opacity-55">{t('observability.colTraceId')}</span>: {String(ev.trace_id)}
          </div>
        ) : null}
        {ev.session_key ? (
          <div className="break-all">
            <span className="opacity-55">{t('observability.colSession')}</span>: {String(ev.session_key)}
          </div>
        ) : null}
      </div>
      <div className="mt-2 border-t pt-2" style={{ borderColor: border }}>
        <div className="mb-1 text-[10px] uppercase tracking-wide opacity-55">
          {t('observability.detailInputOutput')}
        </div>
        <pre
          className="max-h-44 overflow-auto whitespace-pre-wrap break-all rounded-md p-2 font-mono text-[10px] leading-snug"
          style={{ background: preBg }}
        >
          {payloadText}
        </pre>
      </div>
      <div className="mt-2 border-t pt-1.5 text-[10px] opacity-55" style={{ borderColor: border }}>
        {t('observability.ganttTooltipHint')}
      </div>
    </div>
  );
}

export function TraceGanttChart({ events, t, onSelectEvent, dateLocale }: Props) {
  const isDark = useChartDarkMode();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [plotW, setPlotW] = useState(400);
  const [tip, setTip] = useState<TipState | null>(null);
  const closeTimer = useRef<number | null>(null);

  const clearCloseTimer = () => {
    if (closeTimer.current != null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const scheduleHide = () => {
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setTip(null), 160);
  };

  const { segments, winMin, winMax } = useMemo(() => {
    const segs = buildSegments(events);
    if (segs.length === 0) {
      return { segments: segs, winMin: 0, winMax: 1 };
    }
    const t0 = Math.min(...segs.map((s) => s.startMs));
    const t1 = Math.max(...segs.map((s) => s.endMs));
    const pad = Math.max((t1 - t0) * 0.04, 6);
    return { segments: segs, winMin: t0 - pad, winMax: t1 + pad };
  }, [events]);

  const chartHeight = Math.max(96, CHART_TOP_PAD + segments.length * ROW_PX + AXIS_BOTTOM);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const w = el.getBoundingClientRect().width;
      const next = Math.max(120, w - LABEL_COL - PLOT_LEFT - PLOT_RIGHT);
      setPlotW(next);
    });
    ro.observe(el);
    const w0 = el.getBoundingClientRect().width;
    setPlotW(Math.max(120, w0 - LABEL_COL - PLOT_LEFT - PLOT_RIGHT));
    return () => ro.disconnect();
  }, []);

  const span = winMax - winMin || 1;
  const xOf = (ms: number) => PLOT_LEFT + LABEL_COL + ((ms - winMin) / span) * plotW;

  const splitCount = 5;
  const gridLines = useMemo(() => {
    const lines: number[] = [];
    for (let i = 0; i <= splitCount; i++) {
      lines.push(winMin + (span * i) / splitCount);
    }
    return lines;
  }, [winMin, span]);

  const axisMuted = isDark ? '#64748b' : '#94a3b8';
  const labelColor = isDark ? '#94a3b8' : '#475569';
  const splitOpacity = isDark ? 0.12 : 0.28;

  if (segments.length === 0) return null;

  return (
    <div
      className="overflow-x-auto border-b border-slate-200/80 bg-slate-50/40 dark:border-slate-800/60 dark:bg-slate-900/20"
      role="img"
      aria-label={t('observability.ganttAria')}
    >
      <div className="min-w-[280px] px-2 py-2 sm:px-3">
        <div className="mb-1 flex items-baseline justify-between gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-500">
            {t('observability.ganttTitle')}
          </span>
          <span className="font-mono text-[9px] text-slate-400">
            {t('observability.ganttWindowMs', { ms: Math.max(0, Math.round(winMax - winMin)) })}
          </span>
        </div>
        <div ref={wrapRef} style={{ height: chartHeight }} className="relative w-full select-none">
          <svg
            width="100%"
            height={chartHeight}
            className="block"
            style={{ minWidth: 280 }}
            onMouseLeave={scheduleHide}
          >
            {/* Grid + plot frame */}
            {gridLines.map((ms) => {
              const x = xOf(ms);
              return (
                <line
                  key={ms}
                  x1={x}
                  x2={x}
                  y1={CHART_TOP_PAD}
                  y2={chartHeight - AXIS_BOTTOM}
                  stroke={axisMuted}
                  strokeOpacity={splitOpacity}
                  strokeDasharray="4 4"
                  strokeWidth={1}
                />
              );
            })}
            <line
              x1={PLOT_LEFT + LABEL_COL}
              x2={PLOT_LEFT + LABEL_COL + plotW}
              y1={chartHeight - AXIS_BOTTOM + 4}
              y2={chartHeight - AXIS_BOTTOM + 4}
              stroke={axisMuted}
              strokeWidth={1}
            />
            {gridLines.map((ms) => {
              const x = xOf(ms);
              return (
                <text
                  key={`t-${ms}`}
                  x={x}
                  y={chartHeight - 4}
                  textAnchor="middle"
                  fill={axisMuted}
                  fontSize={9}
                  fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                >
                  +{Math.round(ms - winMin)}ms
                </text>
              );
            })}

            {segments.map((s, i) => {
              const name = s.ev.event;
              const short = name.length > 26 ? `${name.slice(0, 26)}…` : name;
              const rowY = CHART_TOP_PAD + i * ROW_PX + ROW_PX / 2;
              const x0 = xOf(s.startMs);
              const x1 = xOf(s.endMs);
              const w = Math.max(x1 - x0, 2);
              const h = Math.min(Math.max(ROW_PX * 0.52, 10), 20);
              const fill = runTypeChartColor(s.rt);
              const stroke = isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.35)';

              return (
                <g key={`${s.ev.ts}-${i}`}>
                  <text
                    x={PLOT_LEFT + LABEL_COL - 6}
                    y={rowY}
                    textAnchor="end"
                    dominantBaseline="middle"
                    fill={labelColor}
                    fontSize={10}
                    fontFamily="ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace"
                  >
                    {short}
                  </text>
                  <rect
                    x={x0}
                    y={rowY - h / 2}
                    width={w}
                    height={h}
                    rx={2}
                    ry={2}
                    fill={fill}
                    stroke={stroke}
                    strokeWidth={1}
                    className="cursor-pointer"
                    onMouseEnter={(e) => {
                      clearCloseTimer();
                      setTip({ idx: i, clientX: e.clientX, clientY: e.clientY });
                    }}
                    onMouseMove={(e) => {
                      setTip((prev) =>
                        prev && prev.idx === i
                          ? { idx: i, clientX: e.clientX, clientY: e.clientY }
                          : prev,
                      );
                    }}
                    onMouseLeave={scheduleHide}
                    onClick={() => onSelectEvent(s.ev)}
                  />
                </g>
              );
            })}
          </svg>

          {tip &&
            typeof document !== 'undefined' &&
            createPortal(
              <div
                className="pointer-events-none fixed z-[1100]"
                style={{
                  left: Math.min(tip.clientX + 12, window.innerWidth - 320),
                  top: Math.min(tip.clientY + 12, window.innerHeight - 120),
                }}
              >
                <div
                  className="pointer-events-auto"
                  onMouseEnter={clearCloseTimer}
                  onMouseLeave={scheduleHide}
                >
                  <GanttTooltipPanel
                    segment={segments[tip.idx]!}
                    t={t}
                    dateLocale={dateLocale}
                    isDark={isDark}
                  />
                </div>
              </div>,
              document.body,
            )}
        </div>
      </div>
    </div>
  );
}
