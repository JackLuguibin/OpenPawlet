/**
 * Date/time display in the agent IANA timezone (``agents.defaults.timezone``),
 * so UI matches OpenPawlet ``local_now(agents.defaults.timezone)`` (no process-wide TZ).
 */

import type { ConfigSection } from '../api/types';

export function parseAgentTimeZoneFromConfig(config: ConfigSection | unknown): string {
  if (!config || typeof config !== 'object') return 'UTC';
  const tz = (config as ConfigSection).agents?.defaults?.timezone;
  if (typeof tz === 'string' && tz.trim()) return tz.trim();
  return 'UTC';
}

function safeTimeZone(iana: string): string {
  const z = iana.trim() || 'UTC';
  try {
    Intl.DateTimeFormat(undefined, { timeZone: z });
    return z;
  } catch {
    return 'UTC';
  }
}

/** Full locale date+time string in the agent zone (for tables, tooltips). */
export function formatAgentLocaleString(
  input: string | number | Date | undefined | null,
  timeZone: string,
  locale: string,
): string {
  if (input === undefined || input === null || input === '') return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const tz = safeTimeZone(timeZone);
  try {
    return d.toLocaleString(locale, { timeZone: tz });
  } catch {
    return d.toLocaleString(locale, { timeZone: 'UTC' });
  }
}

export function formatAgentLocaleDate(
  input: string | number | Date | undefined | null,
  timeZone: string,
  locale: string,
): string {
  if (input === undefined || input === null || input === '') return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const tz = safeTimeZone(timeZone);
  try {
    return d.toLocaleDateString(locale, { timeZone: tz });
  } catch {
    return d.toLocaleDateString(locale, { timeZone: 'UTC' });
  }
}

export function formatAgentLocaleTime(
  input: string | number | Date | undefined | null,
  timeZone: string,
  locale: string,
): string {
  if (input === undefined || input === null || input === '') return '';
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) return '';
  const tz = safeTimeZone(timeZone);
  try {
    return d.toLocaleTimeString(locale, { timeZone: tz });
  } catch {
    return d.toLocaleTimeString(locale, { timeZone: 'UTC' });
  }
}

/**
 * Chat bubble timestamp: date + time with milliseconds, in agent zone
 * (aligned with previous zh/en formatting, with explicit timeZone).
 */
export function formatChatMessageTime(
  isoStr: string | undefined,
  timeZone: string,
  locale: string,
): string {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return '';
  const tz = safeTimeZone(timeZone);
  try {
    const dateStr = d.toLocaleDateString(locale, {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    // fractionalSecondDigits is valid in modern runtimes; DOM typings may lag (TS lib).
    const fmt = new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      fractionalSecondDigits: 3,
      hour12: false,
    } as Intl.DateTimeFormatOptions);
    const parts = fmt.formatToParts(d);
    const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
    const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
    const second = parts.find((p) => p.type === 'second')?.value ?? '';
    const frac = parts.find((p) => (p as { type: string }).type === 'fractionalSecond')?.value;
    const ms = frac != null ? frac.padEnd(3, '0').slice(0, 3) : '000';
    return `${dateStr} ${hour}:${minute}:${second}.${ms}`;
  } catch {
    return '';
  }
}

/** Calendar day YYYY-MM-DD in agent zone (e.g. download filenames). */
export function formatAgentDateISO(
  d: Date,
  timeZone: string,
): string {
  const tz = safeTimeZone(timeZone);
  try {
    return d.toLocaleDateString('en-CA', { timeZone: tz });
  } catch {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(d);
      const y = parts.find((p) => p.type === 'year')?.value;
      const m = parts.find((p) => p.type === 'month')?.value;
      const day = parts.find((p) => p.type === 'day')?.value;
      if (y && m && day) return `${y}-${m}-${day}`;
    } catch {
      /* ignore */
    }
    return '';
  }
}
