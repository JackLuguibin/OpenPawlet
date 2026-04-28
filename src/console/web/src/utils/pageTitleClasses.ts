/**
 * Canonical styles for the primary page `<h1>` (aligned with PageHeader / HubShell).
 */
export const PAGE_PRIMARY_TITLE_CLASS =
  'm-0 text-[20px] font-semibold leading-tight tracking-tight text-gray-900 dark:text-white';

/**
 * Gradient variant used on a few management pages (keeps size/weight in sync with PAGE_PRIMARY_TITLE_CLASS).
 */
export const PAGE_PRIMARY_TITLE_GRADIENT_CLASS =
  'm-0 text-[20px] font-semibold leading-tight tracking-tight bg-gradient-to-r from-gray-900 to-gray-600 bg-clip-text text-transparent dark:from-white dark:to-gray-300';

/**
 * Ant Design `Typography.Title`: `!` so Tailwind wins over component defaults.
 */
export const PAGE_PRIMARY_TITLE_ANT_TITLE_CLASS =
  '!mb-1 !mt-0 !text-[20px] !font-semibold !leading-tight !tracking-tight !text-gray-900 dark:!text-white';
