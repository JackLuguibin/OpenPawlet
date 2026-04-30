import type { AgentObservabilityEvent } from '../api/types';

export type RunType = 'llm' | 'tool' | 'chain' | 'error' | 'other';

export function classifyRunType(event: string): RunType {
  const e = event.toLowerCase();
  if (e.includes('error') || e.includes('fail') || e.includes('exception')) return 'error';
  if (e.includes('llm') || e.includes('model') || e.includes('completion') || e.includes('chat')) return 'llm';
  if (e.includes('tool')) return 'tool';
  if (e.includes('chain') || e.includes('turn') || e.includes('run') || e.includes('agent')) return 'chain';
  return 'other';
}

export function runTypeLabelKey(rt: RunType): string {
  const map: Record<RunType, string> = {
    llm: 'observability.typeLlm',
    tool: 'observability.typeTool',
    chain: 'observability.typeChain',
    error: 'observability.typeError',
    other: 'observability.typeOther',
  };
  return map[rt];
}

export function runTypeTagClass(rt: RunType): string {
  switch (rt) {
    case 'llm':
      return 'border-violet-200/90 bg-violet-50/95 text-violet-800 dark:border-violet-500/30 dark:bg-violet-950/50 dark:text-violet-200';
    case 'tool':
      return 'border-emerald-200/90 bg-emerald-50/95 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-950/50 dark:text-emerald-200';
    case 'chain':
      return 'border-indigo-200/90 bg-indigo-50/95 text-indigo-800 dark:border-indigo-500/30 dark:bg-indigo-950/50 dark:text-indigo-200';
    case 'error':
      return 'border-rose-200/90 bg-rose-50/95 text-rose-800 dark:border-rose-500/30 dark:bg-rose-950/50 dark:text-rose-200';
    default:
      return 'border-slate-200/90 bg-slate-50/95 text-slate-700 dark:border-slate-600 dark:bg-slate-800/60 dark:text-slate-200';
  }
}

/** Solid fills for trace / chart UI (aligned with Tailwind accent bars). */
export function runTypeChartColor(rt: RunType): string {
  switch (rt) {
    case 'llm':
      return '#8b5cf6';
    case 'tool':
      return '#10b981';
    case 'chain':
      return '#6366f1';
    case 'error':
      return '#f43f5e';
    default:
      return '#94a3b8';
  }
}

export function runTypeAccentClass(rt: RunType): string {
  switch (rt) {
    case 'llm':
      return 'bg-violet-500';
    case 'tool':
      return 'bg-emerald-500';
    case 'chain':
      return 'bg-indigo-500';
    case 'error':
      return 'bg-rose-500';
    default:
      return 'bg-slate-300 dark:bg-slate-600';
  }
}

export function isErrorLikeEvent(name: string): boolean {
  const n = name.toLowerCase();
  return n.includes('error') || n.includes('fail') || n.includes('exception');
}

export function observabilityRowKey(r: AgentObservabilityEvent): string {
  let payload = '';
  try {
    payload = JSON.stringify(r.payload ?? {});
  } catch {
    payload = '…';
  }
  return [r.ts, r.event, r.trace_id ?? '', r.session_key ?? '', payload].join('\u001f');
}
