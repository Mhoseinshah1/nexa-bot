import { describe, expect, it } from 'vitest';
import {
  PaymentExpiryLoop,
  PAYMENT_EXPIRY_INTERVAL_MS,
} from '../../apps/api/src/modules/commerce/payments/application/payment-expiry-loop';
import type { PaymentExpiryService } from '../../apps/api/src/modules/commerce/payments/application/payment-expiry.service';
import type { TenantContext } from '@nexa/contracts';

/**
 * The loop around the expiry sweep: what it counts as progress, and what it waits for.
 *
 * The service itself is exercised against a real database in
 * `tests/integration/payments.test.ts`. What cannot be asserted there is the loop's own
 * behaviour under a shutdown or a failing pass, because both need control over when the
 * pass resolves — so the service is a stub here and the timing is the subject.
 */
describe('the payment expiry loop', () => {
  const scope: TenantContext = { tenantId: 'tenant-1', botInstanceId: null } as TenantContext;
  const silent = { info: () => {}, error: () => {} };

  function loopOver(
    runOnce: PaymentExpiryService['runOnce'],
    now: () => number,
    scopeOf: () => TenantContext | null = () => scope,
  ) {
    return new PaymentExpiryLoop({ runOnce } as PaymentExpiryService, {
      scope: scopeOf,
      intervalMs: PAYMENT_EXPIRY_INTERVAL_MS,
      now,
      logger: silent,
    });
  }

  it('waits for a pass already in flight before it reports stopped', async () => {
    /*
     * The shutdown order is `stop()` then `container.shutdown()`, which closes the
     * database pool. A stop that returned while a pass held a transaction would have
     * that connection pulled out from under it — the transaction is atomic so nothing
     * half-writes, but a pass that had already moved rows loses them and the work waits
     * for the next boot, on every rolling deploy.
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
        return { payments: 1, orders: 1 };
      },
      () => 0,
    );

    const pass = loop.tick();
    // The pass is inside its transaction. A stop must not return yet.
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopped, 'stop() returned while a pass was still running').toBe(false);

    release();
    await pass;
    await stopping;
    expect(stopped).toBe(true);
    expect(finished).toBe(true);
  });

  it('counts a pass that moved nothing as progress, and one that threw as none', async () => {
    /*
     * The two halves of an honest heartbeat. "Nothing was due" is the healthy answer
     * most of the time here — unlike the provisioner, whose IDLE is a signal to sleep —
     * so a loop that only counted non-empty passes would report a perfectly healthy
     * installation stale within minutes. A pass that THREW is the state this reports.
     */
    let clock = 0;
    let fail = false;
    const loop = loopOver(
      async () => {
        if (fail) throw new Error('every pass fails');
        return { payments: 0, orders: 0 };
      },
      () => clock,
    );

    loop.start();
    await loop.tick();
    expect(loop.isFresh(clock)).toBe(true);

    fail = true;
    clock += PAYMENT_EXPIRY_INTERVAL_MS * 4;
    await loop.tick();
    expect(loop.isFresh(clock), 'a loop whose every pass throws reported itself fresh').toBe(false);
    await loop.stop();
  });

  it('treats a tenant that does not exist yet as a healthy pass with nothing to do', async () => {
    /*
     * The installation's tenant is a ROW, so a worker booted before `pnpm provision` has
     * none. Reporting that stale would make a fresh install unhealthy for a reason the
     * operator cannot act on — the "different lie" `LoopProgress` names.
     */
    let called = 0;
    const loop = loopOver(
      async () => {
        called += 1;
        return { payments: 0, orders: 0 };
      },
      () => 0,
      () => null,
    );

    loop.start();
    await loop.tick();

    expect(called, 'the sweep ran without a tenant').toBe(0);
    expect(loop.isFresh(0)).toBe(true);
    await loop.stop();
  });
});
