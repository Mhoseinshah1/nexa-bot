import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nextRelayDelayMs,
  OutboxRelay,
  type RelayBatchResult,
} from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';
import type { Database } from '../../apps/api/src/infrastructure/persistence/database';

/**
 * WP16 R1 (`docs/wp16-admin-ops-audit.md`): a batch that made no progress waits.
 *
 * The rule used to be "drain at once while a batch claimed anything", so one message
 * whose consumer always throws kept the relay in a zero-delay loop.
 */
describe('nextRelayDelayMs', () => {
  it('drains at once while a batch publishes something', () => {
    expect(nextRelayDelayMs({ claimed: 100, published: 100, failed: 0 }, 1_000)).toBe(0);
    expect(nextRelayDelayMs({ claimed: 100, published: 1, failed: 99 }, 1_000)).toBe(0);
  });

  it('waits the poll interval when nothing was claimed', () => {
    expect(nextRelayDelayMs({ claimed: 0, published: 0, failed: 0 }, 1_000)).toBe(1_000);
  });

  it('waits the poll interval when everything claimed failed — the poison-message loop', () => {
    expect(nextRelayDelayMs({ claimed: 1, published: 0, failed: 1 }, 1_000)).toBe(1_000);
    expect(nextRelayDelayMs({ claimed: 100, published: 0, failed: 100 }, 250)).toBe(250);
  });

  it('waits when a claimed batch was all skipped (a tenant stopped between claim and dispatch)', () => {
    expect(nextRelayDelayMs({ claimed: 3, published: 0, failed: 0 }, 1_000)).toBe(1_000);
  });
});

/**
 * The running loop takes its delay from `nextRelayDelayMs`, not from a rule of its own.
 *
 * The pure function above could be right while `tick` still scheduled `claimed > 0 ? 0 : poll`
 * inline — the poison-message loop, back, with every test of the function green.
 */
describe('the relay loop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const relayWith = (batch: RelayBatchResult) => {
    const relay = new OutboxRelay(
      {} as Database,
      [],
      { now: () => new Date() },
      { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      { batchSize: 10, pollIntervalMs: 1_000, maxLagMs: 60_000 },
    );
    const processBatch = vi.spyOn(relay, 'processBatch').mockResolvedValue(batch);
    return { relay, processBatch };
  };

  it('does not spin on a batch whose every claimed message failed', async () => {
    vi.useFakeTimers();
    const { relay, processBatch } = relayWith({ claimed: 1, published: 0, failed: 1 });
    relay.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(processBatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(processBatch).toHaveBeenCalledTimes(2);
    await relay.stop();
  });

  it('drains again at once while a batch publishes', async () => {
    vi.useFakeTimers();
    const { relay, processBatch } = relayWith({ claimed: 5, published: 5, failed: 0 });
    relay.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(processBatch.mock.calls.length).toBeGreaterThan(2);
    await relay.stop();
  });
});
