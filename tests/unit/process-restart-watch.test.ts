import { describe, expect, it } from 'vitest';
import {
  PROCESS_RESTART_STORM_CODE,
  PROCESS_RESTART_STORM_ENDED_CODE,
  PROCESS_RESTART_STORM_MIN_RESTARTS,
  PROCESS_RESTART_STORM_WINDOW_MS,
  PROCESS_RUN_STABLE_AFTER_MS,
  type OperationalEventInput,
  type TenantContext,
} from '@nexa/contracts';
import {
  PROCESS_RUN_CHECK_INTERVAL_MS,
  ProcessRestartWatch,
} from '../../apps/api/src/modules/platform/opslog/application/process-restart-watch';
import {
  restartStormConditionKey,
  type ProcessRunRecord,
  type ProcessRunStore,
} from '../../apps/api/src/modules/platform/opslog/application/process-run-state';

/**
 * R11 A3: a role that crashes within seconds and is restarted by the supervisor is reported
 * ONCE per episode. Every case builds a NEW `ProcessRestartWatch` per life, as a restarted
 * process does, and shares only what survives a crash: the persisted run row and the
 * operational-events table. Nothing is remembered in a watch object across lives.
 *
 * The event store behaves as `drizzle-operational-events.ts` does for the facts the
 * announcement depends on: a deduped failure on no row or a RESOLVED row is a message (new /
 * reopened), on an OPEN row it is only counted, and a recovery is always a message and
 * resolves the row it names.
 */

const tenant = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const START = 1_700_000_000_000;
const CRASH_AFTER_MS = 13_000; // v0.8.2's worker died every ~13 s

class MemoryRunStore implements ProcessRunStore {
  readonly rows = new Map<string, ProcessRunRecord>();
  failing = false;
  async transact(
    role: string,
    change: (previous: ProcessRunRecord | null) => ProcessRunRecord | null,
  ): Promise<ProcessRunRecord | null> {
    if (this.failing) throw new Error('database is down');
    const next = change(this.rows.get(role) ?? null);
    if (next !== null) this.rows.set(role, next);
    return next;
  }
}

class EventStore {
  readonly rows = new Map<string, { open: boolean; count: number }>();
  readonly messages: string[] = [];
  readonly recorded: OperationalEventInput[] = [];
  failRecoveries = 0;

  async record(_scope: unknown, event: OperationalEventInput): Promise<never> {
    if (event.code === PROCESS_RESTART_STORM_CODE) {
      const key = event.dedupeKey as string;
      const row = this.rows.get(key);
      if (row === undefined || !row.open) this.messages.push(`${event.code}:${key}`);
      this.rows.set(key, { open: true, count: (row?.count ?? 0) + 1 });
    } else {
      if (this.failRecoveries > 0) {
        this.failRecoveries -= 1;
        throw new Error('write failed');
      }
      this.messages.push(`${event.code}:${event.recoversDedupeKey ?? ''}`);
      const row = this.rows.get(event.recoversDedupeKey as string);
      if (row !== undefined) row.open = false;
    }
    this.recorded.push(event);
    return {} as never;
  }

  async openConditions(_scope: TenantContext, keys: readonly string[]): Promise<string[]> {
    return keys.some((key) => this.rows.get(key)?.open === true)
      ? [PROCESS_RESTART_STORM_CODE]
      : [];
  }

  count(code: string): number {
    return this.messages.filter((message) => message.startsWith(`${code}:`)).length;
  }
}

interface World {
  readonly runs: MemoryRunStore;
  readonly events: EventStore;
  readonly clock: { now: number };
  tenantKnown: boolean;
  /** One process life of `role`, built as production builds it. */
  watch(role?: string): {
    watch: ProcessRestartWatch;
    ticks: { run: () => void; stopped: boolean }[];
  };
  /** A life that dies `afterMs` after it started, without a word. */
  crash(role?: string, afterMs?: number): Promise<void>;
}

function world(): World {
  const runs = new MemoryRunStore();
  const events = new EventStore();
  const clock = { now: START };
  let next = 0;
  const w: World = {
    runs,
    events,
    clock,
    tenantKnown: true,
    watch(role = 'worker') {
      const ticks: { run: () => void; stopped: boolean }[] = [];
      const watch = new ProcessRestartWatch({
        role,
        store: runs,
        recorder: events,
        conditions: events,
        scope: () => (w.tenantKnown ? tenant : null),
        clock: { now: () => new Date(clock.now) },
        newRunId: () => `run-${String((next += 1))}`,
        logger: { warn: () => undefined },
        every: (run) => {
          const tick = { run, stopped: false };
          ticks.push(tick);
          return {
            stop: () => {
              tick.stopped = true;
            },
          };
        },
      });
      return { watch, ticks };
    },
    async crash(role = 'worker', afterMs = CRASH_AFTER_MS) {
      const { watch } = w.watch(role);
      await watch.start();
      clock.now += afterMs;
    },
  };
  return w;
}

const KEY = restartStormConditionKey('worker');

describe('the contract numbers are what the cases below assume', () => {
  it('three restarts open a storm, and a stable life is longer than a crashing one', () => {
    expect(PROCESS_RESTART_STORM_MIN_RESTARTS).toBe(3);
    expect(CRASH_AFTER_MS).toBeLessThan(PROCESS_RUN_STABLE_AFTER_MS);
    expect(PROCESS_RUN_CHECK_INTERVAL_MS).toBeLessThan(PROCESS_RUN_STABLE_AFTER_MS);
  });
});

describe('one crash loop is one message', () => {
  it('says nothing for the first two restarts', async () => {
    const w = world();
    await w.crash(); // boot 1: first ever
    await w.crash(); // boot 2: restart 1
    await w.crash(); // boot 3: restart 2
    expect(w.events.recorded).toEqual([]);
  });

  it('3 quick crashes announce once, with the role, the count and the window', async () => {
    const w = world();
    for (let boot = 0; boot < 4; boot += 1) await w.crash(); // the 4th boot is the 3rd restart
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(1);
    const event = w.events.recorded[0]!;
    expect(event).toMatchObject({
      code: PROCESS_RESTART_STORM_CODE,
      dedupeKey: KEY,
      context: {
        processRole: 'worker',
        restarts: 3,
        windowMinutes: PROCESS_RESTART_STORM_WINDOW_MS / 60_000,
      },
    });
  });

  it('10 quick crashes are still one message; the repeats only count on the open row', async () => {
    const w = world();
    for (let boot = 0; boot < 11; boot += 1) await w.crash();
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(1);
    // Boots 4..11 (restarts 3..10) were each recorded, silently, on the one row.
    expect(w.events.rows.get(KEY)).toEqual({ open: true, count: 8 });
    expect(w.events.recorded.at(-1)?.context).toMatchObject({ restarts: 10 });
  });

  it('two roles in a storm are two conditions and two messages', async () => {
    const w = world();
    for (let boot = 0; boot < 4; boot += 1) {
      await w.crash('worker');
      await w.crash('monitor');
    }
    expect(w.events.messages.sort()).toEqual([
      `${PROCESS_RESTART_STORM_CODE}:${restartStormConditionKey('monitor')}`,
      `${PROCESS_RESTART_STORM_CODE}:${KEY}`,
    ]);
  });

  it('restarts spread over more than the window never make a storm', async () => {
    const w = world();
    // A crash every three minutes: the third restart is six minutes after the first life.
    for (let boot = 0; boot < 8; boot += 1) await w.crash('worker', 3 * 60_000);
    expect(w.events.recorded).toEqual([]);
  });
});

describe('a stable life ends the episode', () => {
  async function stormed(): Promise<World> {
    const w = world();
    for (let boot = 0; boot < 5; boot += 1) await w.crash();
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(1);
    return w;
  }

  it('does nothing before the stable window and records the recovery once after it', async () => {
    const w = await stormed();
    const { watch, ticks } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS - 1;
    await watch.check();
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(0);
    expect(ticks[0]?.stopped).toBe(false);

    w.clock.now += 1;
    await watch.check();
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(1);
    expect(w.events.rows.get(KEY)?.open).toBe(false);
    expect(ticks[0]?.stopped).toBe(true);

    // Later ticks (a timer that fires once more, a second call) add nothing.
    w.clock.now += 5 * PROCESS_RUN_CHECK_INTERVAL_MS;
    await watch.check();
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(1);
  });

  it('clears the streak: the next crash is restart 1, not restart 11', async () => {
    const w = await stormed();
    const { watch } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    await watch.check();
    expect(w.runs.rows.get('worker')).toMatchObject({ restarts: 0, restartsSince: null });
    expect(w.runs.rows.get('worker')?.stableAt).not.toBeNull();

    await w.crash(); // the stable life ended; this boot follows a stable life
    expect(w.runs.rows.get('worker')?.restarts).toBe(0);
    await w.crash();
    expect(w.runs.rows.get('worker')?.restarts).toBe(1);
  });

  it('a new episode after quiet is one new message', async () => {
    const w = await stormed();
    const { watch } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    await watch.check();
    w.clock.now += 60 * 60_000; // an hour of quiet

    for (let boot = 0; boot < 5; boot += 1) await w.crash();
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(2);
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(1);
  });

  it('a stable life with no storm records no recovery (nothing to close)', async () => {
    const w = world();
    const { watch, ticks } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    await watch.check();
    expect(w.events.recorded).toEqual([]);
    expect(ticks[0]?.stopped).toBe(true);
  });

  it('a recovery that could not be written is tried again on the next tick', async () => {
    const w = await stormed();
    const { watch, ticks } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    w.events.failRecoveries = 1;
    await watch.check();
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(0);
    expect(ticks[0]?.stopped).toBe(false);

    w.clock.now += PROCESS_RUN_CHECK_INTERVAL_MS;
    await watch.check();
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(1);
    expect(ticks[0]?.stopped).toBe(true);
  });

  it('two overlapping checks record the recovery once (a slow database, a 10 s timer)', async () => {
    const w = await stormed();
    const { watch } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    // The condition read blocks until released, as a database slower than the interval does.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = w.events.openConditions.bind(w.events);
    let reads = 0;
    w.events.openConditions = async (scope, keys) => {
      reads += 1;
      await gate;
      return read(scope, keys);
    };
    const first = watch.check();
    const second = watch.check(); // the next timer tick, while the first is still awaiting
    release();
    await Promise.all([first, second]);
    expect(reads).toBe(1);
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(1);
  });

  it('a check that was running when the life is stopped records nothing', async () => {
    const w = await stormed();
    const { watch } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = w.events.openConditions.bind(w.events);
    w.events.openConditions = async (scope, keys) => {
      await gate;
      return read(scope, keys);
    };
    const running = watch.check();
    await watch.stop();
    release();
    await running;
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(0);
  });

  it('a life that dies before the stable window leaves the open condition to the next life', async () => {
    const w = await stormed();
    const { watch } = w.watch();
    await watch.start();
    w.clock.now += PROCESS_RUN_STABLE_AFTER_MS - 1;
    await watch.check(); // too early: nothing
    // ... it crashes at 59.999 s. The next life continues the SAME episode, silently.
    await w.crash();
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(1);
    expect(w.events.count(PROCESS_RESTART_STORM_ENDED_CODE)).toBe(0);
    expect(w.events.rows.get(KEY)?.open).toBe(true);
  });
});

describe('a clean stop is not a crash', () => {
  it('an operator restarting a role over and over starts no streak', async () => {
    const w = world();
    for (let boot = 0; boot < 8; boot += 1) {
      const { watch } = w.watch();
      await watch.start();
      w.clock.now += 5_000;
      await watch.stop();
    }
    expect(w.events.recorded).toEqual([]);
    expect(w.runs.rows.get('worker')?.restarts).toBe(0);
  });

  it('a stop ends a streak that was running', async () => {
    const w = world();
    for (let boot = 0; boot < 3; boot += 1) await w.crash();
    const { watch } = w.watch();
    await watch.start(); // boot 4: the third restart, a storm in progress
    await watch.stop();
    await w.crash();
    expect(w.runs.rows.get('worker')?.restarts).toBe(0);
  });

  it('a stop from an older life cannot mark a newer one', async () => {
    const w = world();
    const first = w.watch();
    await first.watch.start();
    await w.crash();
    await first.watch.stop(); // the first life's late write
    expect(w.runs.rows.get('worker')?.stoppedAt).toBeNull();
  });
});

describe('it never takes a role down', () => {
  it('a database that is down at boot is logged, not thrown', async () => {
    const w = world();
    w.runs.failing = true;
    const { watch } = w.watch();
    await expect(watch.start()).resolves.toBeUndefined();
    await expect(watch.stop()).resolves.toBeUndefined();
    expect(w.events.recorded).toEqual([]);
  });

  it('an installation with no tenant announces nothing, and the next boot with one does', async () => {
    const w = world();
    w.tenantKnown = false;
    for (let boot = 0; boot < 5; boot += 1) await w.crash();
    expect(w.events.recorded).toEqual([]);
    w.tenantKnown = true;
    await w.crash();
    expect(w.events.count(PROCESS_RESTART_STORM_CODE)).toBe(1);
  });

  it('start() is idempotent', async () => {
    const w = world();
    const { watch, ticks } = w.watch();
    await watch.start();
    await watch.start();
    expect(ticks).toHaveLength(1);
  });
});
