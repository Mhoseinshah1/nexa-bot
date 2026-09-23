import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { ProvisionerLoop } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner-loop';
import type { ProvisionerService } from '../../apps/api/src/modules/commerce/provisioning/application/provisioner.service';
import type { DeliveryService } from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { OperationOutcomeAnnouncer } from '../../apps/api/src/modules/commerce/messaging/application/operation-outcome-announcer';

/**
 * WHICH results reach the announcer, which is the whole of what this loop decides.
 *
 * The rule under test is not "the announcer works" — `operation-outcome-announcer.test.ts`
 * covers that — but that the loop GIVES it every operation it terminalised. Three
 * refusal paths in `ProvisionerService.runOnce` transition an operation to `ABANDONED`
 * and return `{ kind: 'REFUSED' }`, and the loop used to break on `REFUSED` before
 * announcing. So a customer whose RENEW was refused because this release cannot renew
 * on their panel type was told nothing at all, deterministically rather than as a race.
 * Found by the Codex review of PR #30.
 */
describe('which results the provisioner loop announces', () => {
  const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;

  function loopOver(results: readonly unknown[]) {
    const announced: string[] = [];
    let call = 0;
    const executor = {
      runOnce: async () => results[Math.min(call++, results.length - 1)],
    } as unknown as ProvisionerService;
    const delivery = { deliverDue: async () => undefined } as unknown as DeliveryService;
    const outcomes = {
      announce: async (_scope: TenantContext, operationId: string) => {
        announced.push(operationId);
      },
    } as unknown as OperationOutcomeAnnouncer;
    const loop = new ProvisionerLoop(executor, delivery, outcomes, {
      scope: () => scope,
      cashback: { settleDue: async () => 0 },
      referrals: { settleDue: async () => 0 },
      tickMs: 60_000,
      now: () => 0,
      logger: { info: () => undefined, error: () => undefined },
    });
    return { loop, announced };
  }

  /**
   * The case that was silent.
   *
   * `CAPABILITY_UNSUPPORTED` is reached by transitioning the operation to `ABANDONED`
   * — a real, committed, terminal state — and then returning `REFUSED`. The customer
   * asked for this one and it will never be tried again, so it is exactly the outcome
   * they are owed.
   */
  it('announces an operation a refusal abandoned, before it stops draining', async () => {
    const { loop, announced } = loopOver([
      { kind: 'REFUSED', operationId: 'operation-1', reason: 'CAPABILITY_UNSUPPORTED' },
    ]);
    await loop.tick();
    expect(announced).toEqual(['operation-1']);
  });

  /** And it still STOPS on a refusal: the next operation would hit the same wall. */
  it('stops draining on a refusal, having announced it', async () => {
    const { loop, announced } = loopOver([
      { kind: 'REFUSED', operationId: 'operation-1', reason: 'TENANT_STOPPED' },
    ]);
    await loop.tick();
    expect(announced, 'announced exactly once, then broke').toEqual(['operation-1']);
  });

  it('announces an attempted operation', async () => {
    const { loop, announced } = loopOver([
      {
        kind: 'ATTEMPTED',
        operationId: 'operation-2',
        serviceId: 'service-1',
        outcome: 'SUCCEEDED',
        failureKind: null,
      },
      { kind: 'IDLE' },
    ]);
    await loop.tick();
    expect(announced).toEqual(['operation-2']);
  });

  /**
   * An IDLE tick names no operation, so there is nothing to announce.
   *
   * Asserted because the fix moved the `announce` call ABOVE the break, and an `IDLE`
   * result has no `operationId` at all — announcing for it would pass `undefined` to a
   * reader that would then look up nothing, on every idle tick of every installation.
   */
  it('announces nothing for an idle tick', async () => {
    const { loop, announced } = loopOver([{ kind: 'IDLE' }]);
    await loop.tick();
    expect(announced).toEqual([]);
  });
});
