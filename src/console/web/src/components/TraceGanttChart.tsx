import { useEffect, useMemo, useState } from 'react';
import type {
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  TooltipComponentFormatterCallbackParams,
} from 'echarts';
import type { TFunction } from 'i18next';
import type { AgentObservabilityEvent } from '../api/types';
import { useAppStore } from '../store';
import {
  classifyRunType,
  type RunType,
  runTypeChartColor,
  runTypeLabelKey,
} from '../utils/observabilityRunType';
import type { EChartsOption } from './ModelPieChart';
import { EChartsWithResize } from './ModelPieChart';

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

export function TraceGanttChart({ events, t, onSelectEvent, dateLocale }: Props) {
  const isDark = useChartDarkMode();

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

  const chartHeight = Math.max(96, CHART_TOP_PAD + segments.length * ROW_PX + 36);

  const option = useMemo((): EChartsOption | null => {
    if (segments.length === 0) return null;

    const labelColor = isDark ? '#94a3b8' : '#475569';
    const axisMuted = isDark ? '#64748b' : '#94a3b8';
    const splitOpacity = isDark ? 0.12 : 0.28;

    return {
      animation: false,
      grid: {
        left: 6,
        right: 10,
        top: CHART_TOP_PAD,
        bottom: 22,
        containLabel: true,
      },
      xAxis: {
        type: 'value',
        min: winMin,
        max: winMax,
        axisLabel: {
          formatter: (v: number) => `+${Math.round(v - winMin)}ms`,
          fontSize: 9,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: axisMuted,
        },
        axisLine: { lineStyle: { color: axisMuted } },
        splitLine: {
          show: true,
          lineStyle: { type: 'dashed', opacity: splitOpacity },
        },
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: segments.map((_, i) => i),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          width: 112,
          overflow: 'truncate',
          align: 'right',
          margin: 6,
          fontSize: 10,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          color: labelColor,
          formatter: (val: string | number) => {
            const i = typeof val === 'number' ? val : Number(val);
            if (!Number.isFinite(i) || i < 0 || i >= segments.length) return '';
            const name = segments[i]!.ev.event;
            return name.length > 26 ? `${name.slice(0, 26)}…` : name;
          },
        },
        splitLine: { show: false },
      },
      tooltip: {
        trigger: 'item',
        confine: true,
        enterable: true,
        showDelay: 0,
        backgroundColor: isDark ? 'rgba(15, 23, 42, 0.96)' : 'rgba(255, 255, 255, 0.98)',
        borderColor: isDark ? '#334155' : '#e2e8f0',
        textStyle: {
          color: isDark ? '#f1f5f9' : '#0f172a',
          fontSize: 11,
        },
        extraCssText: 'max-width:min(90vw,22rem);box-shadow:0 4px 24px rgba(0,0,0,0.12);',
        formatter: (raw: TooltipComponentFormatterCallbackParams) => {
          if (Array.isArray(raw)) return '';
          const params = raw as { seriesType?: string; dataIndex?: number };
          if (params.seriesType !== 'custom' || params.dataIndex == null) return '';
          const s = segments[params.dataIndex];
          if (!s) return '';
          const ev = s.ev;
          const rt = classifyRunType(ev.event);
          const barMs = s.endMs - s.startMs;
          const payloadText = formatPayloadPreview(ev.payload as Record<string, unknown>);
          const lines: string[] = [
            `<div style="font-weight:600;margin-bottom:6px">${escapeHtml(ev.event)}</div>`,
            `<div style="opacity:.9;font-size:11px;line-height:1.45">`,
            `<div><span style="opacity:.55">${escapeHtml(t('observability.colTime'))}</span>: ${escapeHtml(formatEventTimestamp(ev.ts, dateLocale))}</div>`,
            `<div><span style="opacity:.55">${escapeHtml(t('observability.colRunType'))}</span>: ${escapeHtml(t(runTypeLabelKey(rt)))}</div>`,
            `<div><span style="opacity:.55">${escapeHtml(t('observability.ganttTooltipBar'))}</span>: ${Math.max(0, Math.round(barMs))} ms</div>`,
          ];
          if (ev.trace_id) {
            lines.push(
              `<div style="word-break:break-all"><span style="opacity:.55">${escapeHtml(t('observability.colTraceId'))}</span>: ${escapeHtml(String(ev.trace_id))}</div>`,
            );
          }
          if (ev.session_key) {
            lines.push(
              `<div style="word-break:break-all"><span style="opacity:.55">${escapeHtml(t('observability.colSession'))}</span>: ${escapeHtml(String(ev.session_key))}</div>`,
            );
          }
          lines.push(`</div>`);
          lines.push(
            `<div style="margin-top:8px;padding-top:8px;border-top:1px solid ${isDark ? 'rgba(148,163,184,.25)' : 'rgba(15,23,42,.1)'}">`,
            `<div style="font-size:10px;opacity:.55;text-transform:uppercase;letter-spacing:.04em;margin-bottom:4px">${escapeHtml(t('observability.detailInputOutput'))}</div>`,
            `<pre style="margin:0;max-height:176px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,monospace;font-size:10px;line-height:1.35;padding:8px;border-radius:6px;background:${isDark ? 'rgba(0,0,0,.35)' : 'rgba(241,245,249,.9)'}">${escapeHtml(payloadText)}</pre>`,
            `</div>`,
            `<div style="margin-top:8px;padding-top:6px;border-top:1px solid ${isDark ? 'rgba(148,163,184,.25)' : 'rgba(15,23,42,.1)'};font-size:10px;opacity:.55">${escapeHtml(t('observability.ganttTooltipHint'))}</div>`,
          );
          return lines.join('');
        },
      },
      series: [
        {
          type: 'custom',
          name: 'spans',
          renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
            const yIdx = Number(api.value(0));
            const x0 = Number(api.value(1));
            const x1 = Number(api.value(2));
            const start = api.coord([x0, yIdx]);
            const end = api.coord([x1, yIdx]);
            const sizeRet = api.size?.([0, 1]);
            const band =
              Array.isArray(sizeRet) && typeof sizeRet[1] === 'number'
                ? sizeRet[1]
                : typeof sizeRet === 'number'
                  ? sizeRet
                  : ROW_PX;
            const height = Math.min(Math.max(band * 0.52, 10), 20);
            const width = Math.max(end[0]! - start[0]!, 2);
            return {
              type: 'rect' as const,
              shape: {
                x: start[0],
                y: start[1] - height / 2,
                width,
                height,
                r: 2,
              },
              style: api.style(),
            };
          },
          encode: { x: [1, 2], y: 0 },
          dimensions: ['y', 'x0', 'x1'],
          data: segments.map((s, i) => ({
            value: [i, s.startMs, s.endMs] as [number, number, number],
            itemStyle: {
              color: runTypeChartColor(s.rt),
              borderColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.35)',
              borderWidth: 1,
            },
          })),
          emphasis: {
            itemStyle: {
              shadowBlur: 8,
              shadowColor: isDark ? 'rgba(0,0,0,0.45)' : 'rgba(15,23,42,0.18)',
            },
          },
        },
      ],
    };
  }, [segments, winMin, winMax, t, dateLocale, isDark]);

  const onEvents = useMemo(
    () => ({
      click: (raw: unknown) => {
        const p = raw as { componentType?: string; seriesType?: string; dataIndex?: number };
        if (p.componentType === 'series' && p.seriesType === 'custom' && typeof p.dataIndex === 'number') {
          const seg = segments[p.dataIndex];
          if (seg) onSelectEvent(seg.ev);
        }
      },
    }),
    [segments, onSelectEvent],
  );

  if (segments.length === 0 || !option) return null;

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
        <EChartsWithResize option={option} style={{ height: chartHeight }} onEvents={onEvents} />
      </div>
    </div>
  );
}
