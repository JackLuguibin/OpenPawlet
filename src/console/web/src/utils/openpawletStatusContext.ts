/**
 * OpenPawlet "status context" payload shape checks.
 *
 * OpenPawlet's outbound `message.data` can carry a JSON document whose `context`
 * key (or nested `data.context`) holds `tokens_estimate` / `window_total`
 * / `percent_used`. Both the chat page renderer and the `/openpawlet-ws` frame
 * mapper need to detect this shape:
 *   - `useOpenPawletChannelWebSocket.ts` maps native `event: status` to
 *     `openpawlet_status_json` with `openpawlet_status_payload`; legacy `message`
 *     + empty text may still stringify into `content`.
 *   - `Chat.tsx` reads structured payloads for the context meter; human-readable
 *     `/status` lines use `parseOpenPawletStatusPlainText`.
 *
 * Keeping a single implementation here avoids the two sites drifting (e.g. if
 * only one is updated when the server payload evolves).
 */

/** True when `root` contains a status `context` object (direct or under `data.context`). */
export function outboundDataHasStatusContext(
  root: Record<string, unknown>,
): boolean {
  return extractOpenPawletStatusContext(root) !== null;
}

/** Pull out the `context` sub-object from an outbound status payload, if any. */
export function extractOpenPawletStatusContext(
  root: Record<string, unknown>,
): Record<string, unknown> | null {
  const direct = root.context;
  if (direct !== undefined && typeof direct === "object" && direct !== null) {
    return direct as Record<string, unknown>;
  }
  const wrapped = root.data;
  if (
    wrapped !== undefined &&
    typeof wrapped === "object" &&
    wrapped !== null &&
    !Array.isArray(wrapped)
  ) {
    const nested = (wrapped as Record<string, unknown>).context;
    if (
      nested !== undefined &&
      typeof nested === "object" &&
      nested !== null
    ) {
      return nested as Record<string, unknown>;
    }
  }
  return null;
}
