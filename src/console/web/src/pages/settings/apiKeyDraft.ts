/**
 * Helpers for the local "draft" rows used by `ApiKeyListEditor` while
 * creating a new instance (no server id assigned yet).
 *
 * Kept in a separate file so `ApiKeyListEditor.tsx` can stay
 * components-only and play nicely with React Fast Refresh.
 */

import type { ApiKeyDraft, MaskedApiKey } from '../../api/types_llm_providers';

/** Local-only row used while a new instance is being staged. */
export interface ApiKeyDraftRow {
  /** Local React key; not sent to the server. */
  tempId: string;
  label: string;
  value: string;
}

let _draftCounter = 0;

function nextDraftId(): string {
  _draftCounter += 1;
  return `draft-${Date.now().toString(36)}-${_draftCounter}`;
}

export function emptyDraftRow(): ApiKeyDraftRow {
  return { tempId: nextDraftId(), label: '', value: '' };
}

export function draftRowsToPayload(rows: ApiKeyDraftRow[]): ApiKeyDraft[] {
  return rows
    .map((r) => ({
      label: r.label.trim(),
      value: r.value.trim(),
    }))
    .filter((r) => r.value.length > 0);
}

/** Number of keys with non-empty stored value (mask leaks no length info beyond this). */
export function configuredKeyCount(keys: MaskedApiKey[] | undefined): number {
  if (!keys) return 0;
  return keys.filter((k) => k.valueLength > 0).length;
}
