import type { ReactNode } from 'react';

export type PageLayoutVariant = 'default' | 'center' | 'bleed';

export interface PageLayoutProps {
  children: ReactNode;
  /**
   * default: padded column with vertical rhythm (gap-6)
   * center: full-area centered content (e.g. loading spinners)
   * bleed: padding only; page controls gaps and sections
   */
  variant?: PageLayoutVariant;
  className?: string;
}

const SHELL = 'flex min-h-0 min-w-0 flex-1 flex-col w-full';

export function PageLayout({
  children,
  variant = 'default',
  className = '',
}: PageLayoutProps) {
  const variantCls =
    variant === 'center'
      ? 'items-center justify-center p-6'
      : variant === 'bleed'
        ? 'p-4 sm:p-6'
        : 'gap-6 p-4 sm:p-6';
  return (
    <div className={[SHELL, variantCls, className].filter(Boolean).join(' ')}>
      {children}
    </div>
  );
}
