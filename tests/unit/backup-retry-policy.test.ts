import { describe, expect, it } from 'vitest';
import {
  BACKUP_MEMORY_FAILURE_COOLDOWN_MS,
  BACKUP_RETRY_BACKOFF_MS,
  backupRetryHold,
  nextScheduleSlotAfter,
  scheduledFailureChain,
} from '../../apps/api/src/modules/platform/backup/application/backup-retry-policy';
import type { BackupRunRow } from '../../apps/api/src/modules/platform/backup/application/ports';

/**
 * The retry policy's arithmetic (Round 8, B4), without a timer. The scheduler-level proof
 * that ticks five minutes apart do not become runs five minutes apart is in
 * `backup-pipeline.test.ts` («no retry storm»).
 */

const T0 = new Date('2026-03-01T09:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

let counter = 0;
function row(over: Partial<BackupRunRow> & { startedAt: Date }): BackupRunRow {
  counter += 1;
  return {
    id: `run-${String(counter)}`,
    trigger: 'SCHEDULED',
    state: 'FAILED',
    stage: 'DUMP',
    finishedAt: new Date(over.startedAt.getTime() + MINUTE),
    leaseOwner: 'w',
    leaseHeartbeatAt: over.startedAt,
    dumpBytes: null,
    archiveBytes: null,
    checksum: null,
    verifiedAt: null,
    deliveryState: 'NOT_ATTEMPTED',
    deliveryAttemptedAt: null,
    deliveryDetail: null,
    failureCode: 'backup.tool_failed',
    failureMessage: null,
    cleanupOk: true,
    cleanupDetail: null,
    archivePrunedAt: null,
    archiveFormat: null,
    partCount: null,
    archiveSealId: null,
    summaryDeliveryState: null,
    phaseDurationsMs: null,
    ...over,
  };
}

/** `n` scheduled failures, the newest at T0, newest first as `latest()` returns them. */
function chainOf(n: number, over: Partial<BackupRunRow> = {}): BackupRunRow[] {
  return Array.from({ length: n }, (_, i) =>
    row({ startedAt: new Date(T0.getTime() - i * 10 * MINUTE), ...over }),
  );
}

const failedAt = T0.getTime() + MINUTE;

describe('the backup retry policy', () => {
  it('holds each step of the chain for its own backoff', () => {
    for (const [index, step] of BACKUP_RETRY_BACKOFF_MS.entries()) {
      const rows = chainOf(index + 1);
      const base = { rows, lastSucceededAt: null, intervalMs: DAY, dailyTime: null };
      const held = backupRetryHold({ ...base, now: new Date(failedAt + step - 1) });
      expect(held?.notBefore.getTime()).toBe(failedAt + step);
      expect(held?.reason).toBe('BACKOFF');
      expect(backupRetryHold({ ...base, now: new Date(failedAt + step) })).toBeNull();
    }
    expect(BACKUP_RETRY_BACKOFF_MS).toEqual([30 * MINUTE, HOUR, 2 * HOUR]);
  });

  it('after the third failure waits for the next interval slot from the last success', () => {
    const last = new Date(T0.getTime() - 25 * HOUR);
    const held = backupRetryHold({
      now: new Date(failedAt + 3 * HOUR),
      rows: chainOf(4),
      lastSucceededAt: last,
      intervalMs: DAY,
      dailyTime: null,
    });
    expect(held?.reason).toBe('NEXT_SLOT');
    expect(held?.notBefore.getTime()).toBe(last.getTime() + 2 * DAY);
  });

  it('never retries an exhausted chain faster than the last step, however short the schedule', () => {
    const held = backupRetryHold({
      now: new Date(failedAt + 20 * MINUTE),
      rows: chainOf(7),
      lastSucceededAt: new Date(T0.getTime() - 3 * HOUR),
      intervalMs: 15 * MINUTE,
      dailyTime: null,
    });
    expect(held?.notBefore.getTime()).toBe(failedAt + 2 * HOUR);
  });

  it('a memory failure keeps its hour even when the backoff step is shorter', () => {
    const held = backupRetryHold({
      now: new Date(failedAt + 45 * MINUTE),
      rows: chainOf(1, { failureCode: 'backup.tool_oom_killed' }),
      lastSucceededAt: null,
      intervalMs: DAY,
      dailyTime: null,
    });
    expect(held?.reason).toBe('MEMORY');
    expect(held?.notBefore.getTime()).toBe(failedAt + BACKUP_MEMORY_FAILURE_COOLDOWN_MS);
  });

  it('counts only SCHEDULED failures since the last verified backup', () => {
    const last = new Date(T0.getTime() - 15 * MINUTE);
    const rows = [
      row({ startedAt: T0 }),
      row({ startedAt: new Date(T0.getTime() - 5 * MINUTE), trigger: 'MANUAL' }),
      row({ startedAt: new Date(T0.getTime() - 10 * MINUTE), state: 'SUCCEEDED' }),
      // Before the last success: a previous outage, over.
      row({ startedAt: new Date(T0.getTime() - 20 * MINUTE) }),
      row({ startedAt: new Date(T0.getTime() - 30 * MINUTE) }),
    ];
    expect(scheduledFailureChain(rows, last).map((one) => one.id)).toEqual([rows[0]?.id]);
    // So the hold is the FIRST step's, not the third's.
    const held = backupRetryHold({
      now: new Date(failedAt + 31 * MINUTE),
      rows,
      lastSucceededAt: last,
      intervalMs: DAY,
      dailyTime: null,
    });
    expect(held).toBeNull();
  });

  it('a run reclaimed as abandoned is a scheduled failure like any other', () => {
    const held = backupRetryHold({
      now: new Date(failedAt + 10 * MINUTE),
      rows: chainOf(1, { failureCode: 'backup.lease_expired' }),
      lastSucceededAt: null,
      intervalMs: DAY,
      dailyTime: null,
    });
    expect(held).not.toBeNull();
  });

  it('holds nothing with no failure since the last success', () => {
    expect(
      backupRetryHold({
        now: T0,
        rows: [row({ startedAt: T0, state: 'SUCCEEDED' })],
        lastSucceededAt: T0,
        intervalMs: DAY,
        dailyTime: null,
      }),
    ).toBeNull();
  });

  it('finds the next slot of each schedule shape', () => {
    // Daily 04:00 Tehran = 00:30Z; after 09:00Z the next one is tomorrow's.
    expect(
      nextScheduleSlotAfter({
        after: T0,
        lastSucceededAt: null,
        intervalMs: DAY,
        dailyTime: '04:00',
      }).toISOString(),
    ).toBe('2026-03-02T00:30:00.000Z');
    // Interval, anchored at the last success: strictly after `after`.
    const last = new Date(T0.getTime() - 6 * HOUR);
    expect(
      nextScheduleSlotAfter({
        after: T0,
        lastSucceededAt: last,
        intervalMs: 6 * HOUR,
        dailyTime: null,
      }).getTime(),
    ).toBe(last.getTime() + 12 * HOUR);
    // Never succeeded: one interval after the failure.
    expect(
      nextScheduleSlotAfter({
        after: T0,
        lastSucceededAt: null,
        intervalMs: 6 * HOUR,
        dailyTime: null,
      }).getTime(),
    ).toBe(T0.getTime() + 6 * HOUR);
  });
});
