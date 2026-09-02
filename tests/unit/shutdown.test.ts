import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@nexa/contracts';
import { createShutdownCoordinator } from '../../apps/api/src/infrastructure/lifecycle/shutdown';

const silent = (): Logger =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

/**
 * Shutdown coordination, tested at the seam rather than by killing a process.
 *
 * The API took SIGTERM and SIGINT and ran its whole close sequence per signal
 * with no guard at all, so a second signal arriving mid-close ran `app.close()`
 * and `container.shutdown()` concurrently with themselves — on a database pool
 * and a set of pollers that are not written to be closed twice. Neither role
 * had a deadline, so a close that hung kept the process alive until the
 * orchestrator's SIGKILL: the same abrupt death, arrived at slowly, with no log
 * line saying what was stuck.
 */
describe('shutdown coordination', () => {
  it('closes once however many signals arrive', async () => {
    const exit = vi.fn();
    let closes = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const coordinator = createShutdownCoordinator({
      name: 'api',
      logger: silent(),
      timeoutMs: 5_000,
      exit,
      close: async () => {
        closes += 1;
        await blocked;
      },
    });

    // Both signals, while the first close is still running. This is the case
    // the API had no defence against.
    const first = coordinator.shutdown('SIGTERM');
    const second = coordinator.shutdown('SIGINT');
    const third = coordinator.shutdown('SIGTERM');

    expect(closes, 'the close sequence ran more than once').toBe(1);
    release();
    await Promise.all([first, second, third]);

    expect(closes).toBe(1);
    expect(coordinator.closes).toBe(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('leaves anyway when the close does not finish in time', async () => {
    const exit = vi.fn();
    const logger = silent();

    const coordinator = createShutdownCoordinator({
      name: 'worker',
      logger,
      timeoutMs: 10,
      exit,
      // Never settles. A connection that will not drain, or a poller mid-request
      // against something unreachable.
      close: () => new Promise<void>(() => {}),
    });

    await coordinator.shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
    // Forced and graceful look identical from outside the process, so the
    // distinction has to be in the log.
    expect(logger.error).toHaveBeenCalled();
  });

  it('reports a close that throws as a failed exit, not a clean one', async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({
      name: 'api',
      logger: silent(),
      timeoutMs: 5_000,
      exit,
      close: () => Promise.reject(new Error('the pool refused to close')),
    });

    await coordinator.shutdown('SIGTERM');

    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exits zero once a close finishes', async () => {
    const exit = vi.fn();
    const coordinator = createShutdownCoordinator({
      name: 'api',
      logger: silent(),
      timeoutMs: 5_000,
      exit,
      close: () => Promise.resolve(),
    });

    await coordinator.shutdown('SIGTERM');
    expect(exit).toHaveBeenCalledWith(0);
  });
});
