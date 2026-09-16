import { describe, expect, it } from 'vitest';
import {
  CustomerNotificationLoop,
  CUSTOMER_NOTIFICATION_INTERVAL_MS,
} from '../../apps/api/src/modules/commerce/messaging/application/customer-notification-loop';
import type { CustomerNotificationService } from '../../apps/api/src/modules/commerce/messaging/application/customer-notification.service';
import type { TenantContext } from '@nexa/contracts';

/**
 * The loop around the customer notification lane: what it counts as progress, and what
 * it waits for.
 *
 * The lane itself is exercised against a real database in
 * `tests/integration/customer-notifications.test.ts`. What cannot be asserted there is
 * the loop's own behaviour under a shutdown or a failing pass, because both need control
 * over when the pass resolves — so the service is a stub here and the timing is the
 * subject.
 */
describe('the customer notification loop', () => {
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
    errored: 0,
    lost: 0,
  };

  function loopOver(
    deliverDue: CustomerNotificationService['deliverDue'],
    now: () => number,
    scopeOf: () => TenantContext | null = () => scope,
  ) {
    return new CustomerNotificationLoop({ deliverDue } as CustomerNotificationService, {
      scope: scopeOf,
      intervalMs: CUSTOMER_NOTIFICATION_INTERVAL_MS,
      now,
      logger: silent,
    });
  }

  it('waits for a pass already in flight before it reports stopped', async () => {
    /*
     * The shutdown order is `stop()` then `container.shutdown()`, which closes the pool.
     * A stop that returned mid-send would leave a row stamped `send_started_at` with no
     * outcome recorded — a stranded send, which the next boot resolves to `UNCONFIRMED`
     * and never retries. That is a customer silently not told, on every rolling deploy.
     */
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const loop = loopOver(
      async () => {
        await inFlight;
        finished = true;
        return { ...nothing, claimed: 1, delivered: 1 };
      },
      () => 0,
    );

    const pass = loop.tick();
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped, 'stop() returned while a pass was still sending').toBe(false);

    release();
    await pass;
    await stopping;
    expect(stopped).toBe(true);
    expect(finished).toBe(true);
  });

  it('counts a pass that sent nothing as progress, and one that threw as none', async () => {
    /*
     * "Nothing was due" is the healthy answer most of the time, so a loop that only
     * counted non-empty passes would report a perfectly healthy installation stale
     * within minutes. A pass that THREW is the state this reports.
     */
    let clock = 0;
    let fail = false;
    const loop = loopOver(
      async () => {
        if (fail) throw new Error('every pass fails');
        return nothing;
      },
      () => clock,
    );

    loop.start();
    await loop.tick();
    expect(loop.isFresh(clock)).toBe(true);

    fail = true;
    clock += CUSTOMER_NOTIFICATION_INTERVAL_MS * 4;
    await loop.tick();
    expect(loop.isFresh(clock), 'a loop whose every pass throws reported itself fresh').toBe(false);
    await loop.stop();
  });

  it('treats a tenant that does not exist yet as a healthy pass with nothing to do', async () => {
    /*
     * The installation's tenant is a ROW, so a worker booted before `pnpm provision` has
     * none. Reporting that stale would make a fresh install unhealthy for a reason the
     * operator cannot act on.
     */
    let called = 0;
    const loop = loopOver(
      async () => {
        called += 1;
        return nothing;
      },
      () => 0,
      () => null,
    );

    loop.start();
    await loop.tick();

    expect(called, 'the lane ran without a tenant').toBe(0);
    expect(loop.isFresh(0)).toBe(true);
    await loop.stop();
  });

  it('refuses a second pass while one is running, rather than queueing it', async () => {
    /*
     * A pass that overran its interval is one still sending, and a second would claim
     * rows the first has leased. Refused rather than queued.
     */
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let passes = 0;
    const loop = loopOver(
      async () => {
        passes += 1;
        await inFlight;
        return nothing;
      },
      () => 0,
    );

    const first = loop.tick();
    await loop.tick();
    expect(passes, 'a second pass started while the first was still sending').toBe(1);
    release();
    await first;
    await loop.stop();
  });
});
