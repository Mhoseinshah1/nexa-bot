import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@nexa/contracts';
import { ReceiptReviewPushLoop } from '../../apps/api/src/modules/commerce/payments/application/receipt-review-push-loop';
import type { ReceiptReviewPushService } from '../../apps/api/src/modules/commerce/payments/application/receipt-review-push.service';

/**
 * The receipt pushes and the refund request cards each run whatever became of the other
 * (Codex review of #83, round 12).
 *
 * The cards ran after the receipts inside one `try`, so a receipt pass that failed on every
 * tick kept every refund card queued behind it, although the cards' own repository and sender
 * were healthy. A failure still costs the tick its progress, so readiness stays honest.
 */
describe('the receipt push loop’s two lanes', () => {
  const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;

  function loopWith(failing: readonly ('receipts' | 'cards')[]) {
    const ran: string[] = [];
    const errors: string[] = [];
    const lane = (name: 'receipts' | 'cards') => ({
      deliverDue: async () => {
        ran.push(name);
        if (failing.includes(name)) throw new Error(`${name} failed`);
        return { claimed: 0, reaped: 0 };
      },
    });
    const loop = new ReceiptReviewPushLoop(
      lane('receipts') as unknown as ReceiptReviewPushService,
      {
        refundRequests: lane('cards'),
        scope: () => scope,
        intervalMs: 10_000,
        now: () => 1_000,
        logger: { info: () => undefined, error: (_context, message) => errors.push(message) },
      },
    );
    return { loop, ran, errors };
  }

  it('delivers the refund cards when the receipt lane keeps failing', async () => {
    const { loop, ran, errors } = loopWith(['receipts']);
    await loop.tick();
    expect(ran).toEqual(['receipts', 'cards']);
    expect(errors).toEqual(['receipt push pass failed']);
    expect(loop.isFresh(1_000), 'a failed lane is not progress').toBe(false);
  });

  it('names the refund card lane when it is the one that fails', async () => {
    const { loop, ran, errors } = loopWith(['cards']);
    await loop.tick();
    expect(ran).toEqual(['receipts', 'cards']);
    expect(errors).toEqual(['refund request card pass failed']);
    expect(loop.isFresh(1_000)).toBe(false);
  });

  it('records progress when both lanes succeed', async () => {
    const { loop, errors } = loopWith([]);
    await loop.tick();
    expect(errors).toEqual([]);
    expect(loop.isFresh(1_000)).toBe(true);
  });
});
