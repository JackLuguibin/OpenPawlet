/** Human-readable message for thrown values (e.g. React Query errors). */
export function formatQueryError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/** Detect 404-style failures from `fetchJson` / API errors. */
export function isNotFoundError(error: unknown): boolean {
  const msg = formatQueryError(error);
  return /\b404\b/.test(msg) || /\bnot\s*found\b/i.test(msg);
}
