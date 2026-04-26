import { useMemo } from 'react';

const LEVELS = new Set(
  'TRACE,DEBUG,INFO,SUCCESS,WARNING,ERROR,CRITICAL'.toUpperCase().split(',')
);

function levelColorClass(level: string): string {
  const u = level.toUpperCase();
  if (u === 'TRACE' || u === 'DEBUG') return 'text-slate-500';
  if (u === 'INFO') return 'text-sky-300';
  if (u === 'SUCCESS') return 'text-emerald-400';
  if (u === 'WARNING') return 'text-amber-400';
  if (u === 'ERROR' || u === 'CRITICAL') return 'text-rose-400';
  return 'text-slate-300';
}

/**
 * Best-effort parse for loguru lines: `time | LEVEL | rest…`
 * If parsing fails, the whole line is shown as one span.
 */
function parseLogLine(line: string): { time: string; level: string; rest: string } | null {
  const i1 = line.indexOf('|');
  if (i1 < 0) return null;
  const i2 = line.indexOf('|', i1 + 1);
  if (i2 < 0) return null;
  const time = line.slice(0, i1).trim();
  const level = line.slice(i1 + 1, i2).trim().split(/\s+/)[0] ?? '';
  const rest = line.slice(i2 + 1);
  if (!LEVELS.has(level.toUpperCase())) {
    return null;
  }
  return { time, level, rest };
}

export interface RuntimeLogViewProps {
  text: string;
  /** Filter substring (client-side, already applied in text before render if parent prefers) */
  className?: string;
  /** Render newest lines first (top-down). */
  newestFirst?: boolean;
  'aria-label'?: string;
}

/**
 * Renders log text with per-line level coloring (loguru-style).
 */
export function RuntimeLogView({
  text,
  className = '',
  newestFirst = false,
  ...rest
}: RuntimeLogViewProps) {
  const lines = useMemo(() => {
    if (!text) return [];
    const base = text.replace(/\n$/, '').split('\n');
    return newestFirst ? [...base].reverse() : base;
  }, [text, newestFirst]);

  return (
    <div
      className={[
        'runtime-log-view font-mono text-[13px] leading-relaxed',
        'text-slate-200 selection:bg-cyan-500/30',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      {...rest}
    >
      {lines.length === 0 ? (
        <span className="text-slate-500">—</span>
      ) : (
        lines.map((line, i) => {
          const parsed = parseLogLine(line);
          if (!parsed) {
            return (
              <div
                key={`l-${i}`}
                className="whitespace-pre-wrap break-words border-b border-white/[0.04] py-0.5 pl-0 pr-1 last:border-0"
              >
                {line}
              </div>
            );
          }
          const { time, level, rest: restStr } = parsed;
          return (
            <div
              key={`l-${i}`}
              className="whitespace-pre-wrap break-words border-b border-white/[0.04] py-0.5 pl-0 pr-1 last:border-0"
            >
              <span className="text-slate-500 select-none tabular-nums">{time}</span>
              <span className="text-slate-600"> | </span>
              <span
                className={`inline-block min-w-[4.5rem] font-semibold ${levelColorClass(level)}`}
              >
                {level}
              </span>
              <span className="text-slate-600"> | </span>
              <span className="text-slate-200/95">{restStr}</span>
            </div>
          );
        })
      )}
    </div>
  );
}
