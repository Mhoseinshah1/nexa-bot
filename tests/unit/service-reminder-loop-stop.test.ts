import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { ServiceReminderLoop } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder-loop';
import type { ServiceReminderService } from '../../apps/api/src/modules/commerce/provisioning/application/service-reminder.service';

/**
 * R5A-2 (Codex, PR #306): the start-up reconcile is tracked, so `stop()` waits for it before
 * the container closes the pool, and it is told to stop after its current batch.
 *
 * MUTATION: dropping `await this.reconciling` from `stop()` fails the first test; dropping
 * the `stopping` flag passed to the reconcile fails the second.
 */
const scope = { tenantId: 't', botInstanceId: null } as unknown as TenantContext;

function loop(reconcile: (s: TenantContext, shouldStop: () => boolean) => Promise<unknown>) {
  return new ServiceReminderLoop({} as ServiceReminderService, {
    scope: () => scope,
    intervalMs: 3_600_000,
    now: () => Date.now(),
    reconcileAtStart: reconcile,
    logger: { info: () => {}, error: () => {} },
  });
}

describe('ServiceReminderLoop.stop and the start-up reconcile', () => {
  it('does not resolve until the in-flight reconcile has finished', async () => {
    let release!: () => void;
    let finished = false;
    const l = loop(
      () =>
        new Promise<void>((resolve) => {
          release = () => {
            finished = true;
            resolve();
          };
        }),
    );
    l.start();
    let stopped = false;
    const stopping = l.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(finished).toBe(true);
    expect(stopped).toBe(true);
  });

  it('tells the reconcile to stop after its current batch', async () => {
    let batches = 0;
    const l = loop(async (_s, shouldStop) => {
      while (!shouldStop() && batches < 1_000) {
        batches += 1;
        await new Promise((r) => setTimeout(r, 5));
      }
    });
    l.start();
    await new Promise((r) => setTimeout(r, 20));
    await l.stop();
    expect(batches).toBeLessThan(100);
  });
});
