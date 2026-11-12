import { describe, expect, it, vi } from 'vitest';
import type { ActorContext, BotInstanceId, TenantContext } from '@nexa/contracts';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type { SubscriptionFilesResult } from '../../apps/api/src/modules/commerce/provisioning/application/subscription-file.service';
import type { ResellerWebContext } from '../../apps/api/src/modules/commerce/reseller-panel/application/reseller-web-access.service';
import {
  ResellerWebPurchaseService,
  type ResellerWebPurchaseDeps,
} from '../../apps/api/src/modules/commerce/reseller-panel/application/reseller-web-purchase.service';

/**
 * PR-5 «ارسال همهٔ لینک‌ها در تلگرام»: a service counts as sent only when something reached the
 * reseller's chat. On a files-only panel the connection files ARE the delivery, so a files
 * answer of STOPPED, RATE_LIMITED, UNAVAILABLE or SENT-with-none is a failure, never a send;
 * beside a delivered link the files stay optional, as in the bot.
 */

const scope = { tenantId: '01900000-0000-7000-8000-000000000001' } as unknown as TenantContext;
const BATCH = '0190aaaa-0000-7000-8000-000000000001';
const context = {
  scope,
  actor: { type: 'CUSTOMER' } as unknown as ActorContext,
  customer: { id: 'cust-1', telegramUserId: '1001' },
  botInstanceId: 'bot-1' as BotInstanceId,
} as unknown as ResellerWebContext;

const service = (id: string): ServiceRecord =>
  ({
    id,
    customerId: 'cust-1',
    state: 'ACTIVE',
    subscriptionUrl: `https://sub.example.com/${id}`,
  }) as unknown as ServiceRecord;

function purchases(filesOnly: boolean, files: SubscriptionFilesResult) {
  const record = vi.fn().mockResolvedValue(undefined);
  const redeliver = vi.fn().mockResolvedValue(undefined);
  const deps = {
    repository: {
      findBatch: vi.fn().mockResolvedValue({ id: BATCH, customerId: 'cust-1' }),
      batchOrders: vi.fn().mockResolvedValue([{ orderId: 'order-1' }]),
    },
    services: { findByOrderId: vi.fn().mockResolvedValue(service('svc-1')) },
    delivery: { isFilesOnly: vi.fn().mockResolvedValue(filesOnly), redeliver },
    files: { sendAfterDelivery: vi.fn().mockResolvedValue(files) },
    audit: { record },
  } as unknown as ResellerWebPurchaseDeps;
  return { service: new ResellerWebPurchaseService(deps), record, redeliver };
}

describe('sendLinks — the delivery outcome decides what counts as sent', () => {
  it.each<[string, SubscriptionFilesResult]>([
    ['STOPPED', { outcome: 'STOPPED', sent: 0 }],
    ['RATE_LIMITED', { outcome: 'RATE_LIMITED', retryAfterSeconds: 30 }],
    ['UNAVAILABLE', { outcome: 'UNAVAILABLE' }],
    ['NOT_FOUND', { outcome: 'NOT_FOUND' }],
    ['SENT with none delivered', { outcome: 'SENT', sent: 0, failed: 2 }],
  ])('a files-only service whose files did not arrive (%s) is a failure', async (_, files) => {
    const { service: purchase, record } = purchases(true, files);
    expect(await purchase.sendLinks(context, BATCH)).toEqual({ sent: 0, failed: 1 });
    expect(record).toHaveBeenCalledWith(
      scope,
      context.actor,
      expect.objectContaining({ after: { batchId: BATCH, sent: 0, failed: 1 }, result: 'FAILED' }),
    );
  });

  it('a files-only service counts once its files reached the chat', async () => {
    const { service: purchase, redeliver } = purchases(true, {
      outcome: 'SENT',
      sent: 2,
      failed: 0,
    });
    expect(await purchase.sendLinks(context, BATCH)).toEqual({ sent: 1, failed: 0 });
    expect(redeliver).not.toHaveBeenCalled();
  });

  it('beside a delivered link the files are optional: the link counts', async () => {
    const { service: purchase, redeliver } = purchases(false, { outcome: 'UNAVAILABLE' });
    expect(await purchase.sendLinks(context, BATCH)).toEqual({ sent: 1, failed: 0 });
    expect(redeliver).toHaveBeenCalledTimes(1);
  });
});
