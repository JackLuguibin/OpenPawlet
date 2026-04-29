import { useEffect, useMemo, useState } from 'react';
import { Card, Radio, Select, TimePicker, Space, Checkbox, InputNumber } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useTranslation } from 'react-i18next';

type CronMode = 'minute' | 'hour' | 'daily' | 'weekly' | 'monthly' | 'custom';

interface CronExpressionBuilderProps {
  value: string;
  onChange: (expr: string) => void;
}

const PRESET_EXAMPLES: { label: string; expr: string }[] = [
  { label: 'every minute', expr: '* * * * *' },
  { label: 'every 5 minutes', expr: '*/5 * * * *' },
  { label: 'every hour', expr: '0 * * * *' },
  { label: 'daily 09:00', expr: '0 9 * * *' },
  { label: 'weekdays 09:00', expr: '0 9 * * 1-5' },
  { label: 'monday 09:00', expr: '0 9 * * 1' },
  { label: '1st of month 00:00', expr: '0 0 1 * *' },
];

function detectMode(expr: string): CronMode {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return 'custom';
  const [m, h, dom, mon, dow] = parts;
  if (m === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'minute';
  if (/^\*\/\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'minute';
  if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') return 'hour';
  if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*' && dow === '*') return 'daily';
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    dom === '*' &&
    mon === '*' &&
    /^[0-6](?:[-,][0-6])*$/.test(dow)
  )
    return 'weekly';
  if (
    /^\d+$/.test(m) &&
    /^\d+$/.test(h) &&
    /^\d+$/.test(dom) &&
    mon === '*' &&
    dow === '*'
  )
    return 'monthly';
  return 'custom';
}

function parseHourMinute(expr: string): { hour: number; minute: number } {
  const parts = expr.trim().split(/\s+/);
  return {
    hour: Number(parts[1] ?? 9) || 0,
    minute: Number(parts[0] ?? 0) || 0,
  };
}

function parseEveryMinutes(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  const m = parts[0] ?? '*';
  if (m === '*') return 1;
  const match = m.match(/^\*\/(\d+)$/);
  return match ? Number(match[1]) : 1;
}

function parseWeekdays(expr: string): number[] {
  const parts = expr.trim().split(/\s+/);
  const dow = parts[4] ?? '*';
  if (dow === '*') return [];
  return dow.split(',').flatMap((segment) => {
    if (segment.includes('-')) {
      const [a, b] = segment.split('-').map((x) => Number(x));
      const out: number[] = [];
      for (let i = a; i <= b; i++) out.push(i);
      return out;
    }
    return [Number(segment)];
  });
}

function parseMonthDay(expr: string): number {
  const parts = expr.trim().split(/\s+/);
  return Number(parts[2] ?? 1) || 1;
}

export function CronExpressionBuilder(props: CronExpressionBuilderProps) {
  const { value, onChange } = props;
  const { t } = useTranslation();
  const [mode, setMode] = useState<CronMode>(() => detectMode(value));

  useEffect(() => {
    setMode(detectMode(value));
  }, [value]);

  const { hour, minute } = parseHourMinute(value);
  const everyMinutes = parseEveryMinutes(value);
  const weekdays = parseWeekdays(value);
  const monthDay = parseMonthDay(value);
  const time = useMemo<Dayjs>(() => dayjs().hour(hour).minute(minute).second(0), [hour, minute]);

  const handleModeChange = (next: CronMode) => {
    setMode(next);
    if (next === 'minute') onChange('*/5 * * * *');
    else if (next === 'hour') onChange('0 * * * *');
    else if (next === 'daily') onChange('0 9 * * *');
    else if (next === 'weekly') onChange('0 9 * * 1-5');
    else if (next === 'monthly') onChange('0 9 1 * *');
  };

  const updateTime = (parts: { minute?: number; hour?: number; dom?: number; dow?: string }) => {
    const cur = value.trim().split(/\s+/);
    const m = String(parts.minute ?? cur[0] ?? 0);
    const h = String(parts.hour ?? cur[1] ?? 0);
    const dom = String(parts.dom ?? cur[2] ?? '*');
    const mon = String(cur[3] ?? '*');
    const dow = String(parts.dow ?? cur[4] ?? '*');
    onChange(`${m} ${h} ${dom} ${mon} ${dow}`);
  };

  const weekdayOptions = [
    { label: t('cron.weekday.sun'), value: 0 },
    { label: t('cron.weekday.mon'), value: 1 },
    { label: t('cron.weekday.tue'), value: 2 },
    { label: t('cron.weekday.wed'), value: 3 },
    { label: t('cron.weekday.thu'), value: 4 },
    { label: t('cron.weekday.fri'), value: 5 },
    { label: t('cron.weekday.sat'), value: 6 },
  ];

  return (
    <Card size="small" className="mb-3" styles={{ body: { padding: 12 } }}>
      <Radio.Group
        size="small"
        value={mode}
        onChange={(e) => handleModeChange(e.target.value as CronMode)}
        optionType="button"
        buttonStyle="solid"
        className="mb-3 flex-wrap"
        options={[
          { label: t('cron.modeMinute'), value: 'minute' },
          { label: t('cron.modeHour'), value: 'hour' },
          { label: t('cron.modeDaily'), value: 'daily' },
          { label: t('cron.modeWeekly'), value: 'weekly' },
          { label: t('cron.modeMonthly'), value: 'monthly' },
          { label: t('cron.modeCustom'), value: 'custom' },
        ]}
      />

      {mode === 'minute' && (
        <Space>
          <span>{t('cron.builderEvery')}</span>
          <InputNumber
            min={1}
            max={59}
            value={everyMinutes}
            onChange={(v) => onChange(`*/${Math.max(1, Number(v) || 1)} * * * *`)}
          />
          <span>{t('cron.builderMinutes')}</span>
        </Space>
      )}

      {mode === 'hour' && (
        <Space>
          <span>{t('cron.builderAtMinute')}</span>
          <InputNumber
            min={0}
            max={59}
            value={minute}
            onChange={(v) => updateTime({ minute: Math.max(0, Math.min(59, Number(v) || 0)), hour: 0 })}
          />
          <span>{t('cron.builderEveryHour')}</span>
        </Space>
      )}

      {mode === 'daily' && (
        <Space>
          <span>{t('cron.builderAt')}</span>
          <TimePicker
            value={time}
            format="HH:mm"
            onChange={(v) =>
              v && updateTime({ minute: v.minute(), hour: v.hour(), dom: '*' as unknown as number, dow: '*' })
            }
          />
        </Space>
      )}

      {mode === 'weekly' && (
        <Space orientation="vertical" className="w-full">
          <Checkbox.Group
            options={weekdayOptions}
            value={weekdays}
            onChange={(vals) =>
              updateTime({
                dow: (vals as number[]).length ? (vals as number[]).sort().join(',') : '*',
              })
            }
          />
          <Space>
            <span>{t('cron.builderAt')}</span>
            <TimePicker
              value={time}
              format="HH:mm"
              onChange={(v) =>
                v && updateTime({ minute: v.minute(), hour: v.hour() })
              }
            />
          </Space>
        </Space>
      )}

      {mode === 'monthly' && (
        <Space>
          <span>{t('cron.builderDayOfMonth')}</span>
          <InputNumber
            min={1}
            max={31}
            value={monthDay}
            onChange={(v) => updateTime({ dom: Math.max(1, Math.min(31, Number(v) || 1)) })}
          />
          <span>{t('cron.builderAt')}</span>
          <TimePicker
            value={time}
            format="HH:mm"
            onChange={(v) => v && updateTime({ minute: v.minute(), hour: v.hour() })}
          />
        </Space>
      )}

      {mode === 'custom' && (
        <Space orientation="vertical" className="w-full">
          <span className="text-xs text-gray-500">{t('cron.builderPresets')}</span>
          <Select
            placeholder={t('cron.builderPresetsPh')}
            options={PRESET_EXAMPLES.map((p) => ({ label: `${p.label}  →  ${p.expr}`, value: p.expr }))}
            onChange={onChange}
            allowClear
            className="w-full"
          />
        </Space>
      )}
    </Card>
  );
}

