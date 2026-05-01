import type { ReactNode } from 'react';
import { ConsolePageHeading, ConsolePageTitleBlock } from './ConsolePageChrome';

export interface PageHeaderProps {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Optional right-aligned actions (buttons, switches, search). */
  actions?: ReactNode;
}

/**
 * Standalone page header used by the new dedicated pages.
 *
 * Visual style intentionally mirrors `HubShell` / `ConsolePageHeading`.
 */
export function PageHeader({ title, subtitle, actions }: PageHeaderProps) {
  return (
    <ConsolePageHeading
      surface="hero"
      rowGapClass="gap-4"
      heading={<ConsolePageTitleBlock title={title} subtitle={subtitle} />}
      extra={
        actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : undefined
      }
    />
  );
}
