import type { ReactNode } from 'react';
import { PageLayout, type PageLayoutVariant } from './PageLayout';
import {
  PAGE_PRIMARY_TITLE_CLASS,
  PAGE_PRIMARY_TITLE_GRADIENT_CLASS,
} from '../utils/pageTitleClasses';

function cn(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(' ');
}

export interface ConsolePageShellProps {
  children: ReactNode;
  embedded?: boolean;
  variant?: PageLayoutVariant;
  /** Appended to PageLayout (e.g. `gap-6`, `!gap-0`) */
  className?: string;
  /** Appended to inner flex wrapper (e.g. `gap-6` between stacked sections) */
  innerClassName?: string;
}

/**
 * Outer console chrome: ambient background when not embedded, flex column, z-stacking.
 */
export function ConsolePageShell({
  children,
  embedded = false,
  variant = 'default',
  className = '',
  innerClassName = '',
}: ConsolePageShellProps) {
  const shell = embedded ? '' : ' console-page-shell';
  return (
    <PageLayout
      variant={variant}
      embedded={embedded}
      className={cn('min-h-0 flex-1 overflow-hidden', shell, className || undefined)}
    >
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden',
          !embedded && 'relative z-[1]',
          innerClassName || undefined,
        )}
      >
        {children}
      </div>
    </PageLayout>
  );
}

const HERO_OUTER = 'console-page-hero mb-4 shrink-0 sm:mb-5';

export interface ConsolePageHeadingProps {
  /** Card-style title strip vs flat row (hub tab / embedded) */
  surface: 'hero' | 'plain';
  /** Left column: title + description nodes */
  heading: ReactNode;
  /** Right-aligned toolbar */
  extra?: ReactNode;
  /** Horizontal gap between heading and extra (default 3; Dashboard uses 4) */
  rowGapClass?: string;
  /** Cross-axis alignment when title and `extra` share one row (`items-*` on the flex row). */
  rowAlign?: 'start' | 'center' | 'end';
  /** Extra classes on outer wrapper */
  className?: string;
  /** Extra classes on heading column (e.g. Logs `max-w-2xl`) */
  headingColClassName?: string;
  /** Extra classes on the right toolbar column */
  extraClassName?: string;
  /** When `lg`, row layout starts at `lg:` instead of `sm:` (Logs page). */
  rowBreakAt?: 'sm' | 'lg';
}

/**
 * Shared title row: hero card or plain strip + optional right `extra` slot.
 */
export function ConsolePageHeading({
  surface,
  heading,
  extra,
  rowGapClass = 'gap-3',
  rowAlign = 'start',
  className,
  headingColClassName,
  extraClassName,
  rowBreakAt = 'sm',
}: ConsolePageHeadingProps) {
  const rowAlignSm =
    rowBreakAt === 'sm'
      ? rowAlign === 'center'
        ? 'sm:items-center'
        : rowAlign === 'end'
          ? 'sm:items-end'
          : 'sm:items-start'
      : '';
  const rowAlignLg =
    rowBreakAt === 'lg'
      ? rowAlign === 'center'
        ? 'lg:items-center'
        : rowAlign === 'end'
          ? 'lg:items-end'
          : 'lg:items-start'
      : '';

  const rowFlex =
    rowBreakAt === 'lg'
      ? cn('flex flex-col lg:flex-row lg:justify-between', rowGapClass, rowAlignLg)
      : cn('flex flex-col sm:flex-row sm:justify-between', rowGapClass, rowAlignSm);

  const extraColCls =
    rowBreakAt === 'lg'
      ? 'flex w-full shrink-0 flex-wrap items-center justify-end gap-2 lg:w-auto lg:justify-end'
      : 'flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto sm:justify-end';

  const row = (
    <div className={rowFlex}>
      <div
        className={cn(
          surface === 'hero' && 'console-page-hero-text min-w-0 flex-1',
          surface === 'plain' && 'min-w-0 flex-1',
          headingColClassName,
        )}
      >
        {heading}
      </div>
      {extra ? (
        <div className={cn(extraColCls, extraClassName)}>{extra}</div>
      ) : null}
    </div>
  );

  if (surface === 'plain') {
    return <div className={cn('shrink-0 pb-2', className)}>{row}</div>;
  }
  return <div className={cn(HERO_OUTER, className)}>{row}</div>;
}

export interface ConsolePageTitleBlockProps {
  title: ReactNode;
  subtitle?: ReactNode;
  titleVariant?: 'default' | 'gradient';
  /**
   * Default: hero subtitle (slate). Pass embedded/plain subtitle classes when using
   * `ConsolePageHeading` with `surface="plain"`.
   */
  subtitleClassName?: string;
}

/** Standard `<h1>` + optional subtitle for use inside `ConsolePageHeading`. */
export function ConsolePageTitleBlock({
  title,
  subtitle,
  titleVariant = 'default',
  subtitleClassName = 'mt-1.5 max-w-2xl text-[13px] leading-relaxed text-slate-600 dark:text-slate-400',
}: ConsolePageTitleBlockProps) {
  const titleCls =
    titleVariant === 'gradient' ? PAGE_PRIMARY_TITLE_GRADIENT_CLASS : PAGE_PRIMARY_TITLE_CLASS;
  const titleEl =
    typeof title === 'string' || typeof title === 'number' ? (
      <h1 className={titleCls}>{title}</h1>
    ) : (
      title
    );
  return (
    <>
      {titleEl}
      {subtitle ? (
        typeof subtitle === 'string' ? (
          <p className={subtitleClassName}>{subtitle}</p>
        ) : (
          <div className={subtitleClassName}>{subtitle}</div>
        )
      ) : null}
    </>
  );
}
