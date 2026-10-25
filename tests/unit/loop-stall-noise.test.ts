import { describe, expect, it } from 'vitest';
import {
  JOB_LOOP_RECOVERED_CODE,
  JOB_LOOP_STALLED_CODE,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  LOOP_BOOT_GRACE_MS,
  LOOP_RECOVERY_CONFIRM_MS,
  LOOP_STALL_RERECORD_MS,
  LoopStallReporter,
  loopStallConditionKey,
  type LoopStatus,
} from '../../apps/api/src/modules/platform/opslog/application/loop-stall-reporter';

/**
 * v0.8.2 hotfix, item 5. A worker that crash-looped every ~13 s posted the same
 * `job.loop_stalled` / `job.loop_recovered` pair to the ops group once a minute, with a
 * growing count, for loops that had never had the chance to run.
 *
 * Why: (1) the first heartbeat of a boot runs before the worker has started some of its
 * loops, and a loop not yet started is "not fresh" — a stall on every boot; (2) the next
 * beat found it fresh and CLOSED the condition, so the following boot REOPENED it, and a
 * reopened condition is a new message with a bigger count. The reporter's memory is in the
 * process; the condition's is in the database, and a restart loses the first and not the
 * second.
 *
 * The store below behaves as `drizzle-operational-events.ts` does, for the three facts the
 * announcements depend on: a stall on no row or a RESOLVED row is a message (new / reopened),
 * a stall on an OPEN row is only counted, and a recovery is always a message and resolves.
 */

const tenant = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const START = 1_700_000_000_000;
const BEAT = 10_000;

class ConditionStore {
  readonly rows = new Map<string, { open: boolean; count: number }>();
  readonly messages: string[] = [];

  async record(_scope: unknown, event: OperationalEventInput): Promise<never> {
    if (event.code === JOB_LOOP_STALLED_CODE) {
      const key = event.dedupeKey as string;
      const row = this.rows.get(key);
      if (row === undefined || !row.open) this.messages.push(`${event.code}:${key}`);
      this.rows.set(key, { open: true, count: (row?.count ?? 0) + 1 });
    } else {
      this.messages.push(`${event.code}:${event.recoversDedupeKey ?? ''}`);
      const row = this.rows.get(event.recoversDedupeKey as string);
      if (row !== undefined) row.open = false;
    }
    return {} as never;
  }

  async openConditions(_scope: TenantContext, keys: readonly string[]): Promise<string[]> {
    return keys.some((key) => this.rows.get(key)?.open === true) ? [JOB_LOOP_STALLED_CODE] : [];
  }

  count(code: string): number {
    return this.messages.filter((message) => message.startsWith(`${code}:`)).length;
  }
}

/** One process life: a reporter born at `clock.now`, built exactly as production builds it. */
function boot(store: ConditionStore, clock: { now: number }): LoopStallReporter {
  return new LoopStallReporter({
    recorder: store,
    conditions: store,
    scope: () => tenant,
    clock: { now: () => new Date(clock.now) },
    logger: { warn: () => undefined },
    role: 'worker',
  });
}

const stalled = (...names: string[]): LoopStatus[] =>
  names.map((name) => ({ name, stalled: true }));
const fresh = (...names: string[]): LoopStatus[] => names.map((name) => ({ name, stalled: false }));
const LOOPS = ['legacy-compaction-executor', 'backup-scheduler', 'backup-housekeeping'];

describe('the defaults are real windows', () => {
  it('are positive, so none of the cases below can pass by having no window', () => {
    expect(LOOP_BOOT_GRACE_MS).toBeGreaterThan(0);
    expect(LOOP_RECOVERY_CONFIRM_MS).toBeGreaterThan(0);
  });
});

describe('one episode is one stalled message and one recovered message', () => {
  it('a loop that recovers posts the recovery once, however long it then stays fresh', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    const reporter = boot(store, clock);
    clock.now += LOOP_BOOT_GRACE_MS;

    await reporter.observe(stalled('backup-scheduler'));
    clock.now += BEAT;
    await reporter.observe(stalled('backup-scheduler'));
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);

    // Fresh for the whole confirmation window and then for a long time after it.
    for (let elapsed = 0; elapsed <= LOOP_RECOVERY_CONFIRM_MS + 20 * BEAT; elapsed += BEAT) {
      await reporter.observe(fresh('backup-scheduler'));
      clock.now += BEAT;
    }
    expect(store.count(JOB_LOOP_RECOVERED_CODE)).toBe(1);
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);
  });

  it('a stall that goes on is recorded again slowly and announced once', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    const reporter = boot(store, clock);
    clock.now += LOOP_BOOT_GRACE_MS;
    for (let elapsed = 0; elapsed <= 3 * LOOP_STALL_RERECORD_MS; elapsed += BEAT) {
      await reporter.observe(stalled('backup-scheduler'));
      clock.now += BEAT;
    }
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);
    // Recorded again every LOOP_STALL_RERECORD_MS, not on every beat: 0, 5, 10 and 15 minutes.
    expect(store.rows.get(loopStallConditionKey('backup-scheduler'))?.count).toBe(4);
  });

  it('a stall that returns inside the confirmation window is the same episode', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    const reporter = boot(store, clock);
    clock.now += LOOP_BOOT_GRACE_MS;
    await reporter.observe(stalled('fx-refresh'));
    // Fresh for a few beats, stalled again, fresh again: never fresh for a whole window.
    for (let flap = 0; flap < 6; flap += 1) {
      clock.now += BEAT;
      await reporter.observe(fresh('fx-refresh'));
      clock.now += BEAT;
      await reporter.observe(stalled('fx-refresh'));
    }
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);
    expect(store.count(JOB_LOOP_RECOVERED_CODE)).toBe(0);

    // And a real recovery afterwards is one message.
    for (let elapsed = 0; elapsed <= LOOP_RECOVERY_CONFIRM_MS; elapsed += BEAT) {
      clock.now += BEAT;
      await reporter.observe(fresh('fx-refresh'));
    }
    expect(store.count(JOB_LOOP_RECOVERED_CODE)).toBe(1);
  });
});

describe('a boot says nothing about a loop that has not had its first window', () => {
  it('posts no stall while the process is young, even for loops not started yet', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    const reporter = boot(store, clock);
    // The v0.8.2 shape: the first beat precedes the start of three loops.
    for (let age = 0; age < LOOP_BOOT_GRACE_MS; age += BEAT) {
      await reporter.observe(stalled(...LOOPS));
      clock.now += BEAT;
    }
    expect(store.messages).toEqual([]);
  });

  it('closes nothing it inherited while the process is young either', async () => {
    const store = new ConditionStore();
    store.rows.set(loopStallConditionKey('backup-scheduler'), { open: true, count: 4 });
    const clock = { now: START };
    const reporter = boot(store, clock);
    for (let age = 0; age < LOOP_BOOT_GRACE_MS + LOOP_RECOVERY_CONFIRM_MS - BEAT; age += BEAT) {
      await reporter.observe(fresh('backup-scheduler'));
      clock.now += BEAT;
    }
    expect(store.messages).toEqual([]);
    // Fresh for a full window after the grace: now it is closed, once.
    await reporter.observe(fresh('backup-scheduler'));
    clock.now += BEAT;
    await reporter.observe(fresh('backup-scheduler'));
    expect(store.messages).toEqual([
      `${JOB_LOOP_RECOVERED_CODE}:${loopStallConditionKey('backup-scheduler')}`,
    ]);
  });

  it('still reports a loop that really is not running once the first window has passed', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    const reporter = boot(store, clock);
    clock.now += LOOP_BOOT_GRACE_MS;
    await reporter.observe(stalled('backup-housekeeping'));
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);
  });
});

describe('a restart storm is rolled up against the stored condition', () => {
  it('posts nothing across many restarts that die inside the first window', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    for (let life = 0; life < 20; life += 1) {
      const reporter = boot(store, clock);
      // v0.8.2: stalled on the first beat, fresh on the second, dead at 13 s.
      await reporter.observe(stalled(...LOOPS));
      clock.now += BEAT;
      await reporter.observe(fresh(...LOOPS));
      clock.now += 3_000 + 47_000;
    }
    expect(store.messages).toEqual([]);
  });

  it('posts at most one stalled message, and no recovery, across restarts that outlive the grace but not the confirmation', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    for (let life = 0; life < 10; life += 1) {
      const reporter = boot(store, clock);
      // A long start-up sweep: the three loops are not started for the whole grace, so the
      // first verdict after it is "stalled". They then start and are fresh — and the process
      // dies before they have been fresh for a whole window.
      clock.now += LOOP_BOOT_GRACE_MS;
      await reporter.observe(stalled(...LOOPS));
      clock.now += BEAT;
      await reporter.observe(fresh(...LOOPS));
      clock.now += LOOP_RECOVERY_CONFIRM_MS - 2 * BEAT;
      await reporter.observe(fresh(...LOOPS));
      clock.now += 5_000;
    }
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(LOOPS.length);
    expect(store.count(JOB_LOOP_RECOVERED_CODE)).toBe(0);
    // Each loop's row stayed open and counted every life, silently.
    for (const loop of LOOPS) {
      expect(store.rows.get(loopStallConditionKey(loop))).toEqual({ open: true, count: 10 });
    }
  });

  it('resolves the rolled-up condition once a life finally stays fresh for the window', async () => {
    const store = new ConditionStore();
    const clock = { now: START };
    for (let life = 0; life < 3; life += 1) {
      const reporter = boot(store, clock);
      clock.now += LOOP_BOOT_GRACE_MS;
      await reporter.observe(stalled('backup-scheduler'));
      clock.now += BEAT;
      await reporter.observe(fresh('backup-scheduler'));
      clock.now += 5_000;
    }
    const survivor = boot(store, clock);
    clock.now += LOOP_BOOT_GRACE_MS;
    for (let elapsed = 0; elapsed <= LOOP_RECOVERY_CONFIRM_MS; elapsed += BEAT) {
      await survivor.observe(fresh('backup-scheduler'));
      clock.now += BEAT;
    }
    expect(store.count(JOB_LOOP_STALLED_CODE)).toBe(1);
    expect(store.count(JOB_LOOP_RECOVERED_CODE)).toBe(1);
  });
});
