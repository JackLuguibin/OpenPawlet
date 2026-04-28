import type { ReactNode } from 'react';
import { PAGE_PRIMARY_TITLE_CLASS } from '../utils/pageTitleClasses';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional right-aligned actions (buttons, switches, search). */
  actions?: ReactNode;
}

/**
 * Standalone page header used by the new dedicated pages.
 *
 * Visual style intentionally mirrors the heading block previously rendered by
 * `HubShell` so that splitting a hub into independent pages does not change
 * the look-and-feel users are used to.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <header className="shrink-0 pb-2 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className={PAGE_PRIMARY_TITLE_CLASS}>
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-gray-500 dark:text-gray-400">
            {subtitle}
          </p>
        ) : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}
