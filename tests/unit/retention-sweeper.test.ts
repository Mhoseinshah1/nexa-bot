import { describe, expect, it, vi } from 'vitest';
import { RetentionSweeper } from '../../apps/api/src/modules/platform/identity/application/retention-sweeper';

/**
 * One capped batch per tick is a cleanup RATE, and a rate below the rate rows
 * arrive at still grows without bound: a caller producing more distinct
 * throttle subjects per hour than the batch size simply outruns it. The drain
 * loop is pure scheduling logic, so it is pinned here rather than against a
 * database.
 */

const clock = { now: () => new Date('2026-09-01T00:00:00.000Z') };
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
} as never;

/** A table holding `total` eligible rows, deleted `limit` at a time. */
function backlog(total: number) {
  let remaining = total;
  const calls: number[] = [];
  return {
    calls,
    get remaining() {
      return remaining;
    },
    purge: async (_now: Date, limit: number) => {
      calls.push(limit);
      const removed = Math.min(limit, remaining);
      remaining -= removed;
      return removed;
    },
  };
}

describe('RetentionSweeper', () => {
  it('keeps taking batches until the backlog is drained', async () => {
    const table = backlog(25);
    const sweeper = new RetentionSweeper({ name: 't', purge: table.purge }, clock, logger, {
      intervalMs: 3_600_000,
      initialDelayMs: 3_600_000,
      batchSize: 5,
      maxBatchesPerTick: 1_000,
    });

    // A single batch would have removed 5 and left 20 for an hour later.
    expect(await sweeper.sweep()).toBe(25);
    expect(table.remaining).toBe(0);
    // Five full batches, then a sixth that comes back short and ends the pass.
    expect(table.calls).toHaveLength(6);
  });

  it('stops at the per-tick ceiling so a pass is always bounded', async () => {
    const table = backlog(1_000);
    const sweeper = new RetentionSweeper({ name: 't', purge: table.purge }, clock, logger, {
      intervalMs: 3_600_000,
      initialDelayMs: 3_600_000,
      batchSize: 10,
      maxBatchesPerTick: 3,
    });

    expect(await sweeper.sweep()).toBe(30);
    expect(table.remaining).toBe(970);
    expect(table.calls).toHaveLength(3);
  });

  it('warns when it yields with work still outstanding', async () => {
    const warn = vi.fn();
    const table = backlog(100);
    const sweeper = new RetentionSweeper(
      { name: 'login-throttle', purge: table.purge },
      clock,
      { ...logger, warn } as never,
      { intervalMs: 3_600_000, initialDelayMs: 3_600_000, batchSize: 10, maxBatchesPerTick: 2 },
    );

    await sweeper.sweep();
    // Silence here would be a backlog nobody is told about.
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toMatchObject({ task: 'login-throttle', removed: 20 });
  });

  it('ends the pass on an empty table without a second query', async () => {
    const table = backlog(0);
    const sweeper = new RetentionSweeper({ name: 't', purge: table.purge }, clock, logger, {
      intervalMs: 3_600_000,
      initialDelayMs: 3_600_000,
      batchSize: 5,
      maxBatchesPerTick: 1_000,
    });

    expect(await sweeper.sweep()).toBe(0);
    expect(table.calls).toHaveLength(1);
  });

  it('sweeps soon after start, not only one interval later', async () => {
    // `setInterval` alone fires an hour after boot, so a worker restarting more
    // often than that would never sweep and the tables would grow exactly as if
    // housekeeping did not exist.
    const table = backlog(3);
    const sweeper = new RetentionSweeper({ name: 't', purge: table.purge }, clock, logger, {
      // An interval far longer than this test will ever wait.
      intervalMs: 3_600_000,
      initialDelayMs: 5,
      batchSize: 10,
      maxBatchesPerTick: 10,
    });

    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 40));
    await sweeper.stop();
    expect(table.remaining).toBe(0);
  });

  it('does not overlap two sweeps', async () => {
    let inFlight = 0;
    let overlapped = false;
    let release: (() => void) | null = null;
    const sweeper = new RetentionSweeper(
      {
        name: 't',
        purge: async () => {
          inFlight += 1;
          if (inFlight > 1) overlapped = true;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          inFlight -= 1;
          return 0;
        },
      },
      clock,
      logger,
      { intervalMs: 1, initialDelayMs: 1, batchSize: 5, maxBatchesPerTick: 1_000 },
    );

    sweeper.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    release?.();
    await sweeper.stop();
    expect(overlapped).toBe(false);
  });
});
