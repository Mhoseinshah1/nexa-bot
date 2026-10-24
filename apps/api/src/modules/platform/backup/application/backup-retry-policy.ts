import { PLATFORM_ERROR_CODES } from '@nexa/contracts';
import { latestDailySlot } from './backup-schedule.js';
import type { BackupRunRow } from './ports.js';

/**
 * When the scheduler may try again after its own runs failed (Round 8, B4).
 *
 * WHY THIS EXISTS. "Due" is measured from the last VERIFIED backup, and a failure
 * deliberately does not move it (a failing run must not reset the clock as though it had
 * worked). Before this, the only thing between one failed scheduled run and the next was
 * the scheduler's tick, `BACKUP_TICK_MS`, five minutes by default: every tick after a
 * failure found the backup still due and started another full dump. On a host whose disk
 * was full that was a run every five minutes, each failing ~30 s in and each one more
 * alert-worthy failure, until somebody freed the disk by hand. Only a MEMORY failure had a
 * pause (an hour), so every other failure code retried at tick speed.
 *
 * THE RULE. The chain is the SCHEDULED runs that failed since the last verified backup.
 * After the n-th failure in the chain the next scheduled attempt waits:
 *
 *   n = 1   30 minutes after it finished
 *   n = 2   1 hour
 *   n = 3   2 hours
 *   n ≥ 4   until the next slot of the schedule (the next daily time, or the next interval
 *           boundary measured from the last verified backup), and never less than the last
 *           step: a 15-minute schedule does not turn back into a storm.
 *
 * A memory failure keeps its own, longer, hour (`BACKUP_MEMORY_FAILURE_COOLDOWN_MS`) when it
 * is the newest. A MANUAL run is never held back — an operator who has freed the disk should
 * be able to try — and a manual failure neither lengthens nor resets the chain; a verified
 * backup of ANY trigger ends it, because that is what `lastSucceededAt` reads.
 *
 * A run reclaimed as abandoned (`backup.lease_expired`) is a SCHEDULED failure like any
 * other, so a worker killed in every run backs off too.
 */
export const BACKUP_RETRY_BACKOFF_MS: readonly number[] = [
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
];

/** After a MEMORY failure: no other scheduled run for an hour (Round 5B). */
export const BACKUP_MEMORY_FAILURE_COOLDOWN_MS = 60 * 60_000;

const MEMORY_FAILURE_CODES: ReadonlySet<string> = new Set([
  PLATFORM_ERROR_CODES.BACKUP_TOOL_OOM_KILLED,
  PLATFORM_ERROR_CODES.BACKUP_MEMORY_INSUFFICIENT,
]);

/**
 * How many recent rows the scheduler reads to find the chain. Only the first four failures
 * change the answer, so a bound well above that is exact for any realistic interleaving of
 * manual runs.
 */
export const BACKUP_RETRY_LOOKBACK = 25;

const DAY_MS = 24 * 3_600_000;

export interface BackupRetryHold {
  /** The scheduled failures since the last verified backup, newest first. */
  readonly failures: number;
  /** The newest of them. */
  readonly newest: BackupRunRow;
  /** No scheduled run before this instant. */
  readonly notBefore: Date;
  readonly reason: 'BACKOFF' | 'MEMORY' | 'NEXT_SLOT';
}

/** The scheduled failures since `lastSucceededAt`, newest first, from `latest(n)`'s rows. */
export function scheduledFailureChain(
  rows: readonly BackupRunRow[],
  lastSucceededAt: Date | null,
): readonly BackupRunRow[] {
  return rows.filter(
    (row) =>
      row.trigger === 'SCHEDULED' &&
      row.state === 'FAILED' &&
      (lastSucceededAt === null || row.startedAt.getTime() > lastSucceededAt.getTime()),
  );
}

/** The first slot of the schedule strictly after `after`. */
export function nextScheduleSlotAfter(input: {
  readonly after: Date;
  readonly lastSucceededAt: Date | null;
  readonly intervalMs: number;
  readonly dailyTime: string | null;
}): Date {
  if (input.dailyTime !== null) {
    return new Date(latestDailySlot(input.after, input.dailyTime).getTime() + DAY_MS);
  }
  const after = input.after.getTime();
  if (input.lastSucceededAt === null) return new Date(after + input.intervalMs);
  const anchor = input.lastSucceededAt.getTime();
  const k = Math.floor((after - anchor) / input.intervalMs) + 1;
  return new Date(anchor + Math.max(1, k) * input.intervalMs);
}

/**
 * Whether the scheduler must hold off now, and until when. Null: it may run.
 *
 * Pure, so the arithmetic is tested without a timer and the scheduler stays the thin
 * "decides WHEN" layer it was written as.
 */
export function backupRetryHold(input: {
  readonly now: Date;
  readonly rows: readonly BackupRunRow[];
  readonly lastSucceededAt: Date | null;
  readonly intervalMs: number;
  readonly dailyTime: string | null;
}): BackupRetryHold | null {
  const chain = scheduledFailureChain(input.rows, input.lastSucceededAt);
  const newest = chain[0];
  if (newest === undefined) return null;
  const failedAt = (newest.finishedAt ?? newest.startedAt).getTime();
  const steps = BACKUP_RETRY_BACKOFF_MS;
  const lastStep = steps[steps.length - 1] ?? 0;
  let notBefore: number;
  let reason: BackupRetryHold['reason'];
  if (chain.length <= steps.length) {
    notBefore = failedAt + (steps[chain.length - 1] ?? lastStep);
    reason = 'BACKOFF';
  } else {
    const slot = nextScheduleSlotAfter({
      after: new Date(failedAt),
      lastSucceededAt: input.lastSucceededAt,
      intervalMs: input.intervalMs,
      dailyTime: input.dailyTime,
    }).getTime();
    notBefore = Math.max(slot, failedAt + lastStep);
    reason = 'NEXT_SLOT';
  }
  if (newest.failureCode !== null && MEMORY_FAILURE_CODES.has(newest.failureCode)) {
    const cooled = failedAt + BACKUP_MEMORY_FAILURE_COOLDOWN_MS;
    if (cooled > notBefore) {
      notBefore = cooled;
      reason = 'MEMORY';
    }
  }
  if (input.now.getTime() >= notBefore) return null;
  return { failures: chain.length, newest, notBefore: new Date(notBefore), reason };
}
