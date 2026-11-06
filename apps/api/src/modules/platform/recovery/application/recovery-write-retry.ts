/**
 * The bounds of a write of a `recovery_requests` row that keeps failing.
 *
 * A restore swaps the database under a role that still holds the tenant it cached at
 * startup, so the row's tenant foreign key can fail on every attempt. Retried on every
 * tick for ever, that is a log flood and a role that reads unhealthy until somebody
 * restarts it. Instead: a few attempts with exponential backoff, then give up and say so
 * once; the tenant guard decides what happens next.
 */
export const RECOVERY_WRITE_ATTEMPTS = 5;
export const RECOVERY_WRITE_BASE_DELAY_MS = 500;
export const RECOVERY_WRITE_MAX_DELAY_MS = 10_000;

/** The wait after failed attempt `attempt` (1-based): doubles, capped. */
export function recoveryWriteBackoffMs(
  attempt: number,
  baseMs = RECOVERY_WRITE_BASE_DELAY_MS,
  maxMs = RECOVERY_WRITE_MAX_DELAY_MS,
): number {
  return Math.min(maxMs, baseMs * 2 ** (attempt - 1));
}

export type BoundedWriteResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly attempts: number; readonly error: unknown };

/**
 * Runs `op` up to `attempts` times, sleeping the backoff between attempts (never after the
 * last). `onFailure` runs after each failed attempt and before its backoff; it may throw
 * nothing that matters (its own failure is ignored).
 */
export async function runBoundedWrite(options: {
  readonly op: () => Promise<void>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly onFailure?: (error: unknown, attempt: number) => Promise<void>;
  readonly attempts?: number;
}): Promise<BoundedWriteResult> {
  const attempts = options.attempts ?? RECOVERY_WRITE_ATTEMPTS;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await options.op();
      return { ok: true };
    } catch (error) {
      last = error;
      await options.onFailure?.(error, attempt).catch(() => undefined);
      if (attempt < attempts) await options.sleep(recoveryWriteBackoffMs(attempt));
    }
  }
  return { ok: false, attempts, error: last };
}
