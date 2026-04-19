/**
 * Shared Tailwind Typography classes for Markdown previews across console pages.
 */

const MARKDOWN_PROSE_SHARED = `
  prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-gray-900 dark:prose-headings:text-gray-100
  prose-h2:text-lg prose-h2:mt-8 prose-h2:mb-4 prose-h2:pb-2 prose-h2:border-b prose-h2:border-gray-200 dark:prose-h2:border-gray-600
  prose-h3:text-base prose-h3:mt-6 prose-h3:mb-3
  prose-p:leading-relaxed prose-p:text-gray-700 dark:prose-p:text-gray-300 prose-p:my-2
  prose-li:marker:text-primary-500 prose-ul:my-3 prose-ol:my-3
  prose-strong:text-gray-900 dark:prose-strong:text-gray-100
  prose-hr:my-8 prose-hr:border-gray-200 dark:prose-hr:border-gray-600
  prose-a:text-primary-600 dark:prose-a:text-primary-400 prose-a:no-underline hover:prose-a:underline
`;

function proseClass(template: string): string {
  return template.replace(/\s+/g, ' ').trim();
}

/** Default body text for full-page or card Markdown. */
export const MARKDOWN_PROSE_CLASS = proseClass(`
  prose prose-slate dark:prose-invert max-w-none
  ${MARKDOWN_PROSE_SHARED}
`);

/** Smaller base size (e.g. modal previews). */
export const MARKDOWN_PROSE_CLASS_COMPACT = proseClass(`
  prose prose-slate dark:prose-invert prose-sm max-w-none
  ${MARKDOWN_PROSE_SHARED}
`);
