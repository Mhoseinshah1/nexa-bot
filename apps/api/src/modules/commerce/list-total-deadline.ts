import type { ListTotal } from '@nexa/contracts';

/** How long a list waits for its count chip's total before answering without it. */
export const LIST_TOTAL_WAIT_MS = 1_500;

/**
 * Waits for a total for at most `ms`, then gives up with `null`. PostgreSQL's own
 * `statement_timeout` (see `listTotal`) is what cancels the query; this is what stops the
 * PAGE waiting on it, for a slow pool checkout or a slow lookup as much as a slow count.
 * A rejection is `null` too: a total never fails the list that asked for it.
 */
export async function totalWithin(
  run: () => Promise<ListTotal | null>,
  ms: number = LIST_TOTAL_WAIT_MS,
): Promise<ListTotal | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(run)
        .catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
