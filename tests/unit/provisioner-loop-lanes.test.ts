import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { ProvisionerLoop } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import type { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';

/**
 * The three settlement lanes each run whatever became of the others (Codex review of #83,
 * round 11).
 *
 * Cashback, referral commissions and refund requests used to run in sequence inside the
 * drain's `try`, so one row that failed for ever in an earlier lane — or a failing drain —
 * kept every later lane from running at all. A refund request whose deletion had already
 * succeeded then stayed EXECUTING: the service gone, the reserved credit never paid. A
 * failure still costs the tick its progress, so readiness stays honest.
 */
describe('the provisioner loop’s settlement lanes', () => {
  const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;

  function loopWith(options: {
    readonly drainFails?: boolean;
    readonly failing?: readonly ('cashback' | 'referrals' | 'serviceRefunds')[];
  }) {
    const ran: string[] = [];
    const errors: { lane?: unknown; message: string }[] = [];
    const lane = (name: 'cashback' | 'referrals' | 'serviceRefunds') => ({
      settleDue: async () => {
        ran.push(name);
        if (options.failing?.includes(name) === true) throw new Error(`${name} row failed`);
        return 0;
      },
    });
    const executor = {
      runOnce: async () => {
        if (options.drainFails === true) throw new Error('drain failed');
        return { kind: 'IDLE' };
      },
    } as unknown as ProvisionerService;
    const delivery = { deliverDue: async () => undefined } as unknown as DeliveryService;
    const outcomes = {
      announce: async () => undefined,
      announceDue: async () => undefined,
    } as unknown as OperationOutcomeAnnouncer;
    const loop = new ProvisionerLoop(executor, delivery, outcomes, {
      scope: () => scope,
      cashback: lane('cashback'),
      referrals: lane('referrals'),
      serviceRefunds: lane('serviceRefunds'),
      tickMs: 60_000,
      now: () => 1_000,
      logger: {
        info: () => undefined,
        error: (context, message) => errors.push({ lane: context.lane, message }),
      },
    });
    return { loop, ran, errors };
  }

  it('settles refund requests when an earlier lane keeps failing', async () => {
    const { loop, ran, errors } = loopWith({ failing: ['cashback'] });
    await loop.tick();
    expect(ran).toEqual(['cashback', 'referrals', 'serviceRefunds']);
    expect(errors).toEqual([{ lane: 'cashback', message: 'provisioner settlement lane failed' }]);
    expect(loop.iterationIsFresh(1_000), 'a failed lane is not progress').toBe(false);
  });

  it('settles every lane when the drain before them fails', async () => {
    const { loop, ran, errors } = loopWith({ drainFails: true });
    await loop.tick();
    expect(ran).toEqual(['cashback', 'referrals', 'serviceRefunds']);
    expect(errors.map((error) => error.message)).toEqual(['provisioner tick failed']);
    expect(loop.iterationIsFresh(1_000), 'a failed drain is not progress').toBe(false);
  });

  it('records progress when every lane succeeds', async () => {
    const { loop, ran, errors } = loopWith({});
    await loop.tick();
    expect(ran).toEqual(['cashback', 'referrals', 'serviceRefunds']);
    expect(errors).toEqual([]);
    expect(loop.iterationIsFresh(1_000)).toBe(true);
  });
});
