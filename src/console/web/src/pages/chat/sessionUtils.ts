import type { SessionInfo } from "../../api/types";

/**
 * Persist the last open session key so a bare `/chat` reload can return to
 * it. Read/written by the bare-route bootstrap and the "new chat" flow.
 */
export const LAST_CONSOLE_SESSION_STORAGE_KEY = "console_last_session_key";

/**
 * Set from the "New chat" button so the bare-route bootstrap does not
 * auto-open an existing row while sessions still exist.
 */
export const OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY = "openpawlet_chat_new_intent";

/**
 * Canonical "last activity" timestamp for a session (newer = larger).
 *
 * Prefers `updated_at` (when any message moved the row) and falls back to
 * `created_at` so freshly created empty rows still compare deterministically.
 *
 * This is the single source of truth for "which session is newest" across
 * the chat page (sidebar highlight/scroll, bare-route bootstrap, delete
 * fallback, 404 recovery). Keeping one rule avoids the UI picking row A in
 * the sidebar while navigation / fallback jumps to row B.
 */
export function sessionInfoLastActiveMs(info: SessionInfo): number {
  const raw = info.updated_at ?? info.created_at;
  if (!raw) {
    return 0;
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Pick the session row with the newest last-activity timestamp. */
export function pickLatestActiveSessionKey(
  rows: SessionInfo[],
): string | null {
  if (rows.length === 0) {
    return null;
  }
  let best = rows[0];
  let bestMs = sessionInfoLastActiveMs(best);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const ms = sessionInfoLastActiveMs(row);
    if (ms >= bestMs) {
      bestMs = ms;
      best = row;
    }
  }
  return best.key;
}

/** Pretty-print each JSONL line; copy still uses raw file text from the API. */
export function formatJsonlForDisplay(raw: string): string {
  const lines = raw.split("\n");
  const blocks: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const obj: unknown = JSON.parse(trimmed);
      blocks.push(JSON.stringify(obj, null, 2));
    } catch {
      blocks.push(line);
    }
  }
  return blocks.join("\n\n");
}

/** True when GET /sessions/:key/transcript failed because the session does not exist. */
export function isSessionMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const msg = error.message;
  return /\b404\b/.test(msg) || /not\s*found/i.test(msg);
}

export function readOpenPawletChatNewIntent(): boolean {
  try {
    return sessionStorage.getItem(OPENPAWLET_CHAT_NEW_INTENT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}
