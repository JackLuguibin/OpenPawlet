import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

export interface SegmentedTabItem<T extends string> {
  key: T;
  label: ReactNode;
}

export interface SegmentedTabsProps<T extends string> {
  tabs: SegmentedTabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  /** Accessible name for the tab list */
  ariaLabel?: string;
  className?: string;
}

const SHELL =
  'inline-flex flex-wrap items-center gap-1 p-1.5 rounded-2xl max-w-full shrink-0 ' +
  'bg-gradient-to-b from-gray-50/95 to-gray-100/90 dark:from-slate-800/90 dark:to-slate-900/75 ' +
  'border border-gray-200/90 dark:border-slate-600/40 ' +
  'shadow-sm shadow-gray-900/[0.04] dark:shadow-black/30 ' +
  'backdrop-blur-sm ' +
  'mt-4 mb-3';

const BTN_BASE =
  'relative shrink-0 rounded-xl px-4 py-2 text-sm font-semibold transition-all duration-200 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 focus-visible:ring-offset-2 ' +
  'dark:focus-visible:ring-offset-slate-900';

const BTN_INACTIVE =
  'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 ' +
  'hover:bg-white/80 dark:hover:bg-slate-700/55';

const BTN_ACTIVE =
  'bg-white dark:bg-slate-700 text-primary-600 dark:text-primary-400 ' +
  'shadow-md ring-1 ring-black/[0.06] dark:ring-white/[0.08]';

/**
 * Pill-style segmented control for switching views (used under PageLayout on several pages).
 */
export function SegmentedTabs<T extends string>({
  tabs,
  value,
  onChange,
  ariaLabel,
  className = '',
}: SegmentedTabsProps<T>) {
  const { t } = useTranslation();
  const tablistLabel = ariaLabel ?? t('common.tabList');
  return (
    <div
      role="tablist"
      aria-label={tablistLabel}
      className={[SHELL, className].filter(Boolean).join(' ')}
    >
      {tabs.map(({ key, label }) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={value === key}
          onClick={() => onChange(key)}
          className={[BTN_BASE, value === key ? BTN_ACTIVE : BTN_INACTIVE].join(' ')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
