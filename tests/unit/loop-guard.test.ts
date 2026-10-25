import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import {
  guardedTick,
  loopTickFailures,
  runGuardedTick,
} from '../../apps/api/src/infrastructure/lifecycle/loop-guard';
import { FxRefreshLoop } from '../../apps/api/src/modules/commerce/fx/application/fx-refresh-loop';

/**
 * Loop isolation (v0.8.2 hotfix). A tick that throws — synchronously or by rejecting — is
 * caught, logged once with its loop's name and counted against that loop alone; the timer
 * keeps firing, the other loops keep theirs, and the process sees no unhandled rejection.
 * Before the guard every timer did `void this.tick()`, so a throw out of a tick's own
 * `catch` became an unhandled rejection and Node 22 exited the whole role.
 */

let seq = 0;
const unique = (name: string) => `${name}-${String((seq += 1))}`;

function recordingLogger() {
  const errors: { context: Record<string, unknown>; message: string }[] = [];
  return {
    errors,
    error(context: Record<string, unknown>, message: string) {
      errors.push({ context, message });
    },
  };
}

/** Rejections Node saw nobody handle, while `body` ran and for one macrotask after. */
async function unhandledDuring(body: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown) => seen.push(reason);
  process.on('unhandledRejection', listener);
  try {
    await body();
    // `unhandledRejection` is emitted after the microtask queue drains: wait a real turn.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('unhandledRejection', listener);
  }
  return seen;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('a guarded tick', () => {
  it('a synchronous throw resolves, is logged once with the loop name, and counted for that loop only', async () => {
    const logger = recordingLogger();
    const failing = unique('sync-thrower');
    const bystander = unique('bystander');
    await expect(
      runGuardedTick(
        failing,
        () => {
          throw new Error('sync boom');
        },
        logger,
      ),
    ).resolves.toBeUndefined();
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]?.context).toMatchObject({ loop: failing, failures: 1 });
    expect(loopTickFailures(failing)).toBe(1);
    expect(loopTickFailures(bystander)).toBe(0);
  });

  it('a rejected tick resolves, is logged once, and counted', async () => {
    const logger = recordingLogger();
    const failing = unique('async-thrower');
    await runGuardedTick(failing, () => Promise.reject(new Error('async boom')), logger);
    await runGuardedTick(failing, () => Promise.reject(new Error('async boom')), logger);
    expect(logger.errors.map((entry) => entry.context['failures'])).toEqual([1, 2]);
    expect(loopTickFailures(failing)).toBe(2);
  });

  it('a logger that itself throws (the v0.8.2 shape) still resolves, and the failure is counted', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const failing = unique('logger-thrower');
    const broken = {
      error: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'emit')");
      },
    };
    await expect(
      runGuardedTick(failing, () => Promise.reject(new Error('x')), broken),
    ).resolves.toBeUndefined();
    expect(loopTickFailures(failing)).toBe(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(failing));
  });

  it('a completed tick is not counted and not logged', async () => {
    const logger = recordingLogger();
    const name = unique('healthy');
    await runGuardedTick(name, () => Promise.resolve('done'), logger);
    expect(logger.errors).toEqual([]);
    expect(loopTickFailures(name)).toBe(0);
  });
});

describe('one throwing loop does not stop the others or the process', () => {
  it('sync and async throwers on timers beside a healthy loop: no unhandled rejection, the healthy one keeps ticking', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    const logger = recordingLogger();
    const syncName = unique('timer-sync-thrower');
    const asyncName = unique('timer-async-thrower');
    const healthyName = unique('timer-healthy');
    let healthyTicks = 0;
    const timers = [
      setInterval(
        guardedTick(
          syncName,
          () => {
            throw new Error('sync tick failure');
          },
          logger,
        ),
        10,
      ),
      setInterval(
        guardedTick(asyncName, () => Promise.reject(new Error('async tick failure')), logger),
        10,
      ),
      setInterval(
        guardedTick(
          healthyName,
          () => {
            healthyTicks += 1;
            return Promise.resolve();
          },
          logger,
        ),
        10,
      ),
    ];
    const unhandled = await unhandledDuring(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    for (const timer of timers) clearInterval(timer);

    expect(unhandled).toEqual([]);
    expect(healthyTicks).toBe(10);
    expect(loopTickFailures(syncName)).toBe(10);
    expect(loopTickFailures(asyncName)).toBe(10);
    expect(loopTickFailures(healthyName)).toBe(0);
    // One line per failed tick, each naming its own loop.
    expect(logger.errors.filter((e) => e.context['loop'] === syncName)).toHaveLength(10);
    expect(logger.errors.filter((e) => e.context['loop'] === asyncName)).toHaveLength(10);
  });

  it('the real FX loop with a logger that throws: it fails alone and is counted', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    const scope: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
    const throwing = () => {
      throw new TypeError("Cannot read properties of undefined (reading 'emit')");
    };
    const before = loopTickFailures('fx-refresh');
    const fx = new FxRefreshLoop(
      { refreshIfDue: () => Promise.resolve({ outcome: 'FAILED', reason: 'NOBITEX:http_403' }) },
      {
        scope: () => scope,
        baseAsset: 'USDT',
        intervalMs: 1_000,
        passBoundMs: 1_000,
        now: () => Date.now(),
        // Every method throws: the back-off warning inside `try`, and again inside `catch`.
        logger: { info: throwing, warn: throwing, error: throwing },
        // The production steps (10 s, 30 s, …): the `catch` backs off to a NEW step and warns
        // again, which is how the throw escaped the tick in v0.8.2.
      },
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const logger = recordingLogger();
    const otherName = unique('beside-fx');
    let otherTicks = 0;
    const other = setInterval(
      guardedTick(
        otherName,
        () => {
          otherTicks += 1;
        },
        logger,
      ),
      1_000,
    );
    fx.start();
    const unhandled = await unhandledDuring(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    clearInterval(other);
    await fx.stop();

    expect(unhandled).toEqual([]);
    expect(otherTicks).toBe(60);
    expect(loopTickFailures('fx-refresh') - before).toBeGreaterThanOrEqual(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('fx-refresh'));
  });

  it('a thrown tick records no progress: the FX loop reads stale once its grace has passed', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    });
    const scope: TenantContext = { tenantId: 'tenant-a' as never, botInstanceId: null };
    const fx = new FxRefreshLoop(
      { refreshIfDue: () => Promise.reject(new Error('thrown pass')) },
      {
        scope: () => scope,
        baseAsset: 'USDT',
        intervalMs: 1_000,
        passBoundMs: 1_000,
        now: () => Date.now(),
        logger: {
          info: () => undefined,
          warn: () => {
            throw new Error('the warning itself throws');
          },
          error: () => undefined,
        },
        backoffMs: [1_000],
      },
    );
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    fx.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fx.isFresh(Date.now())).toBe(false);
    await fx.stop();
  });
});
