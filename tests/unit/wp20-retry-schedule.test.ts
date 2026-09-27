import { describe, expect, it } from 'vitest';
import {
  ANTI_SPAM_MAX_INTERACTIONS,
  DELIVERY_MAX_FAILED_ATTEMPTS,
  deliveryRetryDelayMs,
} from '@nexa/contracts';
import { notificationBackoffMs } from '../../apps/api/src/modules/control/notifications/application/notification-dispatcher';
import { spamVerdictOf } from '../../apps/api/src/modules/commerce/customers/application/anti-spam.service';

/** WP20 (brief §3.1–§3.4): the owner's numbers, as functions. */
describe('the delivery retry schedule', () => {
  it('waits 5 s, 15 s, 60 s, 5 min, 15 min, then an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 9, 12].map((n) => deliveryRetryDelayMs(n))).toEqual([
      5_000, 15_000, 60_000, 300_000, 900_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
  });

  it('takes the LATER of the provider’s retry_after and its own delay, and is never zero', () => {
    expect(deliveryRetryDelayMs(1, 30_000)).toBe(30_000);
    expect(deliveryRetryDelayMs(3, 1_000)).toBe(60_000);
    expect(deliveryRetryDelayMs(1, 0)).toBe(5_000);
    expect(deliveryRetryDelayMs(0)).toBe(5_000);
  });

  it('stops after twelve real failures', () => {
    expect(DELIVERY_MAX_FAILED_ATTEMPTS).toBe(12);
  });
});

describe('the ops lane back-off', () => {
  const options = { baseBackoffMs: 5_000, maxBackoffMs: 300_000 };

  it('never retries earlier than the transport’s retry_after', () => {
    // The largest local wait for a first attempt is 5 s; Telegram asked for 40 s.
    expect(notificationBackoffMs(1, 40_000, options, () => 0.999)).toBe(40_000);
  });

  it('never lets a small retry_after undercut its own back-off', () => {
    // A third attempt waits at least half of 20 s; a retry_after of 1 s does not shorten it.
    expect(notificationBackoffMs(3, 1_000, options, () => 0)).toBe(10_000);
    expect(notificationBackoffMs(1, 0, options, () => 0)).toBe(2_500);
  });
});

describe('the anti-spam verdict', () => {
  it('allows twenty, blocks on the twenty-first, and is silent after it', () => {
    expect(ANTI_SPAM_MAX_INTERACTIONS).toBe(20);
    expect(spamVerdictOf(1)).toBe('ALLOWED');
    expect(spamVerdictOf(20)).toBe('ALLOWED');
    expect(spamVerdictOf(21)).toBe('CROSSED');
    expect(spamVerdictOf(22)).toBe('FLOODING');
    expect(spamVerdictOf(500)).toBe('FLOODING');
  });
});
