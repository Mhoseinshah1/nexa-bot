import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import {
  CustomerNotificationLoop,
  CUSTOMER_NOTIFICATION_INTERVAL_MS,
  CUSTOMER_NOTIFICATION_STALE_AFTER_MS,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification-loop';
import type { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import {
  CUSTOMER_NOTIFICATION_LATENCY_WARN_MS,
  notificationLatency,
  notificationLatencyIsSlow,
} from '../../apps/api/src/modules/commerce/messaging/application/notification-latency';

/**
 * FIX-03 (2026-10-09): «your payment was approved by the gateway» at 09:37, and the message
 * with the amount and the tracking code at about 09:39.
 *
 * The approval is the gateway worker's edit of the invoice message, made in the SAME pass
 * that committed the credit (`GatewayPaymentService.refreshScreens`). The amount and the
 * tracking code are `WALLET_TOPUP_CREDITED`, enqueued in the credit's own transaction and
 * due at once — and then left waiting for the customer notification lane's next pass, which
 * ran once a MINUTE. Nothing in the money path waited; the dispatcher's timer did.
 *
 * These pin the cadence that answers it, and the health tolerance the faster cadence must
 * not shrink. `tests/integration/payment-settlement-latency.test.ts` measures the same thing
 * end to end against a real database.
 */
describe('the customer notification lane is prompt (FIX-03)', () => {
  const scope: TenantContext = { tenantId: 'tenant-1', botInstanceId: null } as TenantContext;
  const silent = { info: () => {}, error: () => {} };
  const nothing = {
    claimed: 0,
    delivered: 0,
    pending: 0,
    failed: 0,
    unconfirmed: 0,
    superseded: 0,
    rateLimited: 0,
    unsupported: 0,
    blocked: 0,
    unreachable: 0,
    quietHours: 0,
    quietReleased: 0,
    errored: 0,
    lost: 0,
  };

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a pass within five seconds of a fact becoming due, not a minute later', async () => {
    vi.useFakeTimers();
    let passes = 0;
    const loop = new CustomerNotificationLoop(
      {
        deliverDue: async () => {
          passes += 1;
          return nothing;
        },
      } as unknown as CustomerNotificationService,
      {
        scope: () => scope,
        // The PRODUCTION cadence, the constant the container passes.
        intervalMs: CUSTOMER_NOTIFICATION_INTERVAL_MS,
        now: () => Date.now(),
        logger: silent,
      },
    );
    loop.start();
    /*
     * A credit committed just after a pass: the worst case. Within five seconds the lane
     * must have looked again. At the old sixty-second cadence it had not, which is the gap
     * the owner read between the two messages.
     */
    await vi.advanceTimersByTimeAsync(5_000);
    expect(passes, 'no pass ran within five seconds of the credit').toBeGreaterThanOrEqual(1);
    await loop.stop();
  });

  it('keeps the worker’s health tolerance at three minutes, whatever the cadence', async () => {
    /*
     * The faster cadence must not make the worker unhealthy for a long pass. One pass sends
     * up to `CUSTOMER_NOTIFICATION_SWEEP_LIMIT` messages one after another, and a backlog
     * after an outage can take a minute; three INTERVALS of two seconds would call that a
     * stalled loop, stop the heartbeat and roll a release back. The tolerance is the one the
     * lane always had — three minutes — stated in time rather than in intervals.
     */
    expect(CUSTOMER_NOTIFICATION_STALE_AFTER_MS).toBe(180_000);
    let clock = 0;
    let release: () => void = () => {};
    const sending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const loop = new CustomerNotificationLoop(
      {
        deliverDue: async () => {
          if (first) {
            first = false;
            return nothing;
          }
          await sending;
          return nothing;
        },
      } as unknown as CustomerNotificationService,
      {
        scope: () => scope,
        intervalMs: CUSTOMER_NOTIFICATION_INTERVAL_MS,
        now: () => clock,
        logger: silent,
      },
    );
    loop.start();
    await loop.tick(); // progress at 0
    const long = loop.tick(); // a pass still sending
    clock = 60_000;
    expect(loop.isFresh(clock), 'a one-minute send backlog reported the lane stalled').toBe(true);
    clock = 179_000;
    expect(loop.isFresh(clock)).toBe(true);
    clock = 181_000;
    expect(loop.isFresh(clock), 'a lane silent for three minutes reported fresh').toBe(false);
    release();
    await long;
    await loop.stop();
  });
});

describe('the notification latency breakdown (FIX-03 instrumentation)', () => {
  const at = (ms: number) => new Date(Date.UTC(2026, 9, 9, 9, 37, 0) + ms);

  it('splits the queue, the pre-send work and the Telegram call itself', () => {
    expect(notificationLatency(at(0), at(1_400), at(1_900), at(2_150))).toEqual({
      queuedMs: 1_400,
      preSendMs: 500,
      sendMs: 250,
      totalMs: 2_150,
    });
  });

  it('never reports a negative figure from a clock that stepped back', () => {
    expect(notificationLatency(at(2_000), at(1_000), at(800), at(500))).toEqual({
      queuedMs: 0,
      preSendMs: 0,
      sendMs: 0,
      totalMs: 0,
    });
  });

  it('calls a first attempt slow only past the documented threshold', () => {
    const slow = CUSTOMER_NOTIFICATION_LATENCY_WARN_MS;
    const waited = (ms: number) => ({ queuedMs: ms, preSendMs: 0, sendMs: 0, totalMs: ms });
    expect(notificationLatencyIsSlow(waited(slow), 0, true)).toBe(false);
    expect(notificationLatencyIsSlow(waited(slow + 1), 0, true)).toBe(true);
    // A retry after a refusal waits the lane's back-off by design: not an anomaly.
    expect(notificationLatencyIsSlow(waited(slow * 10), 1, true)).toBe(false);
    // A reminder held by the tenant's quiet window is the rule working, not a delay.
    expect(notificationLatencyIsSlow(waited(slow * 10), 0, false)).toBe(false);
  });

  it('sets the threshold above the healthy worst case and far below the old cadence', () => {
    // Healthy worst case: a credit committed just after a pass waits one interval, plus the
    // pass's own work. The threshold leaves room for that and for a busy database...
    expect(CUSTOMER_NOTIFICATION_LATENCY_WARN_MS).toBeGreaterThanOrEqual(
      CUSTOMER_NOTIFICATION_INTERVAL_MS * 3,
    );
    // ...and still flags the one-minute wait the owner saw.
    expect(CUSTOMER_NOTIFICATION_LATENCY_WARN_MS).toBeLessThan(60_000);
  });
});
