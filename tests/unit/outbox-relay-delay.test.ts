import { describe, expect, it } from 'vitest';
import { nextRelayDelayMs } from '../../apps/api/src/modules/platform/eventing/infrastructure/outbox-relay';

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
