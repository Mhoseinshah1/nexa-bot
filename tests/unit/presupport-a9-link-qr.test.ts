import { describe, expect, it } from 'vitest';
import {
  resolvePanelPolicy,
  type BotInstanceId,
  type PanelDeliveryMode,
  type TenantContext,
} from '@nexa/contracts';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type {
  CustomerEditMessage,
  CustomerFileMessage,
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { PngQrCodeEncoder } from '../../apps/api/src/infrastructure/qr/qr-png';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';
import { decodeQrPng } from '../support/qr-decode';

/**
 * Pre-support A9: «🔗 لینک اشتراک» on the service card shows the link ON the card and then
 * ONE QR photo of that exact link beneath it — none on a CARD_TEXT panel, none for an edit
 * whose outcome is unknown, and never a second for a replayed tap.
 *
 * The REAL PNG encoder, read back by an independent decoder; a scripted messenger stands in
 * for Telegram, and an in-memory set for the durable claim (its SQL is the idempotency store's
 * unique key, exercised end to end in `provisioning-delivery.test.ts`).
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const BOT = 'bot-1' as BotInstanceId;
const URL = 'https://sub.example.test/sub/0123456789abcdef0123456789abcdef?name=nx7k2m9q';
const CARD = { botInstanceId: BOT, chatId: '5150', messageId: 77 };
const TAP = 'telegram:bot-1:update:9001';

function service(): ServiceRecord {
  return {
    id: 'service-1',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    panelId: 'panel-1',
    productId: 'product-1',
    state: 'ACTIVE',
    providerUsername: 'nx7k2m9q',
    subscriptionUrl: URL,
    deliveryState: 'DELIVERED',
    deliveryAttempts: 1,
    deliveredAt: new Date('2026-09-24T18:00:00Z'),
  } as unknown as ServiceRecord;
}

function harness(
  options: {
    readonly mode?: PanelDeliveryMode;
    readonly edit?: CustomerSendResult;
    readonly active?: boolean;
    /** The claim's store failing (a lost connection, a constraint): it throws. */
    readonly claimThrows?: boolean;
  } = {},
) {
  const edits: CustomerEditMessage[] = [];
  const files: CustomerFileMessage[] = [];
  const texts: CustomerMessage[] = [];
  const claimed = new Set<string>();
  let claims = 0;
  const deps: DeliveryServiceDeps = {
    services: {
      markSendStarted: async () => true,
      recordDelivery: async () => true,
      recordRateLimited: async () => true,
    } as unknown as DeliveryServiceDeps['services'],
    contacts: { contactFor: async () => ({ kind: 'NONE' }) } as never,
    messenger: {
      send: async (_s, message) => {
        texts.push(message);
        return { outcome: 'DELIVERED' };
      },
      sendFile: async (_s, message) => {
        files.push(message);
        return { outcome: 'DELIVERED' };
      },
      edit: async (_s, message) => {
        edits.push(message);
        return options.edit ?? { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
    },
    qr: new PngQrCodeEncoder(),
    card: { factsFor: async () => null },
    scopeActivity: { scopeIsActive: async () => options.active ?? true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
    clock: new FixedClock(new Date('2026-09-24T18:30:00Z')),
    guard: { check: async () => undefined } as never,
    panelPolicy: {
      forPanel: async () =>
        resolvePanelPolicy({ delivery: { mode: options.mode ?? 'CARD_WITH_QR' }, actions: {} }),
    },
    linkQr: {
      claim: async (_s, key) => {
        claims += 1;
        if (options.claimThrows === true) throw new Error('the claim could not be written');
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    },
  };
  const delivery = new DeliveryService(deps);
  const tap = (key: string = TAP) =>
    delivery.redeliver(scope, service(), 'customer-1' as never, '5150', BOT, {
      card: CARD,
      linkQrKey: key,
    });
  return { delivery, deps, tap, edits, files, texts, claimed, claimsTried: () => claims };
}

describe('pre-support A9 — the QR under the link view', () => {
  it('sends ONE QR photo that decodes to exactly the link the view shows', async () => {
    const h = harness();
    await h.tap();

    expect(h.edits).toHaveLength(1);
    const shown = h.edits[0]?.values['subscriptionUrl'];
    expect(shown).toBe(URL);
    expect(h.edits[0]?.messageId, 'the link is shown ON the card').toBe(CARD.messageId);

    expect(h.files).toHaveLength(1);
    const photo = h.files[0] as CustomerFileMessage;
    expect(photo.kind).toBe('PHOTO');
    expect(photo.chatId).toBe(CARD.chatId);
    expect(photo.botInstanceId).toBe(CARD.botInstanceId);
    // Its own caption, never the delivery card's «details in the NEXT message».
    expect(photo.caption).toEqual({ templateKey: 'bot.service.link_qr_caption', values: {} });
    if (photo.source.kind !== 'BYTES') throw new Error('the QR is not bytes');
    expect(decodeQrPng(photo.source.bytes), 'the QR scans to the shown link').toBe(shown);
    expect(h.texts, 'nothing else is sent').toHaveLength(0);
  });

  it('sends no QR on a CARD_TEXT panel, and claims nothing', async () => {
    const h = harness({ mode: 'CARD_TEXT' });
    await h.tap();
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
    expect(h.claimed.size).toBe(0);
  });

  it('sends ONE QR for a replayed tap, and one per distinct tap', async () => {
    const h = harness();
    await h.tap();
    await h.tap();
    expect(h.edits, 'the replay shows the link again').toHaveLength(2);
    expect(h.files, 'but never a second QR').toHaveLength(1);

    await h.tap('telegram:bot-1:update:9002');
    expect(h.files, 'a new tap is a new request').toHaveLength(2);
  });

  it('sends no QR when the link view may not be on the screen', async () => {
    const h = harness({ edit: { outcome: 'UNKNOWN' } });
    await h.tap();
    expect(h.files).toHaveLength(0);
    expect(h.claimed.size).toBe(0);
  });

  it('sends no QR for a tenant that stopped between the view and the photo', async () => {
    const h = harness();
    let calls = 0;
    h.deps.scopeActivity.scopeIsActive = async () => (calls += 1) === 1;
    await h.tap();
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
  });

  it('sends no QR without the tap key', async () => {
    const h = harness();
    await h.delivery.redeliver(scope, service(), 'customer-1' as never, '5150', BOT, {
      card: CARD,
    });
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
  });

  /*
   * Review of PR #211: three branches the first round left unpinned.
   */
  it('sends no QR when the claim cannot be written, and the link view still resolves', async () => {
    const h = harness({ claimThrows: true });
    await expect(h.tap()).resolves.toMatchObject({ state: 'DELIVERED' });
    expect(h.claimsTried()).toBe(1);
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
  });

  it('sends exactly one QR when the edit is refused and the view goes as a new message', async () => {
    const h = harness({ edit: { outcome: 'REFUSED' } });
    await h.tap();
    expect(h.edits).toHaveLength(1);
    expect(h.texts, 'the fallback view').toHaveLength(1);
    expect(h.texts[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.files).toHaveLength(1);
    const photo = h.files[0] as CustomerFileMessage;
    if (photo.source.kind !== 'BYTES') throw new Error('the QR is not bytes');
    expect(decodeQrPng(photo.source.bytes)).toBe(URL);
  });

  it('sends no QR and claims nothing when the edit is rate limited', async () => {
    const h = harness({ edit: { outcome: 'RATE_LIMITED', retryAfterMs: 3000 } });
    await h.tap();
    expect(h.files).toHaveLength(0);
    expect(h.claimsTried()).toBe(0);
    expect(h.claimed.size).toBe(0);
  });
});
