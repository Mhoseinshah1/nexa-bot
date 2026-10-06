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
  CustomerMessageRef,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { PngDeliveryQrRenderer } from '../../apps/api/src/infrastructure/qr/qr-template';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';
import { decodeQrPng } from '../support/qr-decode';

/**
 * B9/C3 (superseding pre-support A9's link view + separate QR): «🔗 لینک اشتراک» on the service
 * card is answered by ONE photo — the QR of the exact link, the link as its caption, the way
 * back under the same message — and the text card it replaced is deleted, best effort. The
 * controlled fallback is the delivery card's: an over-bound caption (refused by the messenger
 * with no request) turns the card into the text view and sends the QR beneath it. None on a
 * CARD_TEXT panel, and nothing at all for a replayed tap.
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
    /** What Telegram answers the FIRST photo (the one that carries the link). */
    readonly photo?: CustomerSendResult;
    /** A card a link change was asked from, claimed for the rotation's answer. */
    readonly rotationCard?: boolean;
  } = {},
) {
  const edits: CustomerEditMessage[] = [];
  const files: CustomerFileMessage[] = [];
  const texts: CustomerMessage[] = [];
  const removed: CustomerMessageRef[] = [];
  const released: string[] = [];
  const claimed = new Set<string>();
  let claims = 0;
  let stamps = 0;
  const deps: DeliveryServiceDeps = {
    services: {
      markSendStarted: async () => {
        stamps += 1;
        return true;
      },
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
        return files.length === 1 && options.photo !== undefined
          ? options.photo
          : { outcome: 'DELIVERED' };
      },
      edit: async (_s, message) => {
        edits.push(message);
        return options.edit ?? { outcome: 'DELIVERED' };
      },
      remove: async (_s, message) => {
        removed.push(message);
        return { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
    },
    ...(options.rotationCard === true
      ? {
          cards: {
            claimRotationCard: async () => ({ ...CARD, operationId: 'operation-1' }),
            release: async (_s: unknown, operationId: string) => {
              released.push(operationId);
              return true;
            },
          } as unknown as NonNullable<DeliveryServiceDeps['cards']>,
        }
      : {}),
    qr: new PngDeliveryQrRenderer(),
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
  return {
    delivery,
    deps,
    tap,
    edits,
    files,
    texts,
    removed,
    released,
    claimed,
    claimsTried: () => claims,
    stamps: () => stamps,
  };
}

const BACK = { data: 'sv:service-1' };

function qrOf(photo: CustomerFileMessage | undefined): string {
  if (photo === undefined || photo.source.kind !== 'BYTES') throw new Error('the QR is not bytes');
  return decodeQrPng(photo.source.bytes) ?? 'UNDECODABLE';
}

describe('B9/C3 — the link, its QR and the keyboard in ONE message', () => {
  it('sends ONE photo: the QR of the link, the link as its caption, the way back on it', async () => {
    const h = harness();
    await expect(h.tap()).resolves.toMatchObject({ state: 'DELIVERED' });

    expect(h.files, 'exactly one send').toHaveLength(1);
    expect(h.edits, 'the card is not edited').toHaveLength(0);
    expect(h.texts, 'no text message').toHaveLength(0);
    const photo = h.files[0] as CustomerFileMessage;
    expect(photo.kind).toBe('PHOTO');
    expect(photo.chatId).toBe(CARD.chatId);
    expect(photo.botInstanceId).toBe(CARD.botInstanceId);
    expect(photo.caption).toEqual({
      templateKey: 'bot.service.subscription',
      values: { subscriptionUrl: URL },
    });
    expect(photo.buttons, 'the keyboard is on the same message').toEqual([
      expect.objectContaining(BACK),
    ]);
    expect(qrOf(photo), 'the QR scans to the captioned link').toBe(URL);
  });

  it('deletes the text card the photo replaced, and only after the photo landed', async () => {
    const h = harness();
    await h.tap();
    expect(h.removed).toEqual([CARD]);

    for (const outcome of [
      { outcome: 'UNKNOWN' },
      { outcome: 'RATE_LIMITED', retryAfterMs: 3000 },
    ] as const) {
      const other = harness({ photo: outcome });
      await other.tap();
      expect(other.removed, `${outcome.outcome}: the card stays`).toHaveLength(0);
      expect(other.files, `${outcome.outcome}: nothing more is sent`).toHaveLength(1);
      expect(other.edits).toHaveLength(0);
    }
  });

  it('falls back over the caption bound: the card becomes the link, the QR goes beneath it', async () => {
    const h = harness({ photo: { outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' } });
    await expect(h.tap()).resolves.toMatchObject({ state: 'DELIVERED' });

    expect(h.files, 'the refused single, then the QR alone').toHaveLength(2);
    expect(h.edits, 'the card becomes the link view').toHaveLength(1);
    expect(h.edits[0]?.messageId).toBe(CARD.messageId);
    expect(h.edits[0]?.templateKey).toBe('bot.service.subscription');
    expect(h.edits[0]?.values['subscriptionUrl'], 'the URL is never cut').toBe(URL);
    expect(h.edits[0]?.buttons).toEqual([expect.objectContaining(BACK)]);
    const qr = h.files[1] as CustomerFileMessage;
    expect(qr.caption).toEqual({ templateKey: 'bot.service.link_qr_caption', values: {} });
    expect(qr.buttons).toBeUndefined();
    expect(qrOf(qr)).toBe(URL);
    expect(h.removed, 'the card IS the link view now').toHaveLength(0);
  });

  it('a photo refused for another reason gets the text view alone', async () => {
    const h = harness({ photo: { outcome: 'REFUSED' } });
    await h.tap();
    expect(h.files).toHaveLength(1);
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.removed).toHaveLength(0);
  });

  it('sends no QR on a CARD_TEXT panel, and claims nothing', async () => {
    const h = harness({ mode: 'CARD_TEXT' });
    await h.tap();
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.files).toHaveLength(0);
    expect(h.claimsTried()).toBe(0);
    expect(h.removed).toHaveLength(0);
  });

  it('a replayed tap sends and stamps nothing; a new tap is a new photo', async () => {
    const h = harness();
    await h.tap();
    await expect(h.tap()).resolves.toMatchObject({ recorded: false });
    expect(h.files, 'never a second photo for the same tap').toHaveLength(1);
    expect(h.edits).toHaveLength(0);
    expect(h.stamps(), 'the replay leaves no send stamp').toBe(1);

    await h.tap('telegram:bot-1:update:9002');
    expect(h.files, 'a new tap is a new request').toHaveLength(2);
  });

  it('the claim stands whatever the photo answered: a lost answer is never re-sent for that tap', async () => {
    const h = harness({ photo: { outcome: 'UNKNOWN' } });
    await h.tap();
    await h.tap();
    expect(h.files).toHaveLength(1);
  });

  it('refuses a tenant that stopped before the claim, and sends nothing', async () => {
    const h = harness();
    let calls = 0;
    h.deps.scopeActivity.scopeIsActive = async () => (calls += 1) === 1;
    await expect(h.tap()).rejects.toMatchObject({ details: { reason: 'SCOPE_INACTIVE' } });
    expect(h.files).toHaveLength(0);
    expect(h.edits).toHaveLength(0);
    expect(h.claimed.size).toBe(0);
  });

  it('without the tap key the link is shown as text on the card, never an unclaimed photo', async () => {
    const h = harness();
    await h.delivery.redeliver(scope, service(), 'customer-1' as never, '5150', BOT, {
      card: CARD,
    });
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
  });

  it('a claim that cannot be written shows the link as text, and resolves', async () => {
    const h = harness({ claimThrows: true });
    await expect(h.tap()).resolves.toMatchObject({ state: 'DELIVERED' });
    expect(h.claimsTried()).toBe(1);
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
  });

  it('a text view whose edit is refused goes once as a new message', async () => {
    const h = harness({ mode: 'CARD_TEXT', edit: { outcome: 'REFUSED' } });
    await h.tap();
    expect(h.edits).toHaveLength(1);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.files).toHaveLength(0);
  });
});

describe('B9/C3 — a link change answered on the card is the QR photo too', () => {
  const rotate = (h: ReturnType<typeof harness>) =>
    h.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });

  it('ONE photo: the QR, the rotation text as caption, the card buttons and the way back', async () => {
    const h = harness({ rotationCard: true });
    await expect(rotate(h)).resolves.toMatchObject({
      sentTo: { chatId: CARD.chatId, botInstanceId: BOT },
    });
    expect(h.files).toHaveLength(1);
    expect(h.edits).toHaveLength(0);
    expect(h.texts).toHaveLength(0);
    const photo = h.files[0] as CustomerFileMessage;
    expect(photo.chatId).toBe(CARD.chatId);
    expect(photo.caption?.templateKey).toBe('bot.service.link_rotated');
    expect(photo.caption?.values['subscriptionUrl']).toBe(URL);
    expect(photo.buttons).toContainEqual(expect.objectContaining(BACK));
    expect(qrOf(photo)).toBe(URL);
    expect(h.removed, 'the «working» card is replaced').toEqual([CARD]);
  });

  it('over the caption bound: the card is edited to the new link, the QR beneath it', async () => {
    const h = harness({
      rotationCard: true,
      photo: { outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' },
    });
    await rotate(h);
    expect(h.edits).toHaveLength(1);
    expect(h.edits[0]?.templateKey).toBe('bot.service.link_rotated');
    expect(h.edits[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.files).toHaveLength(2);
    expect(h.files[1]?.caption?.templateKey).toBe('bot.service.link_qr_caption');
    expect(h.removed).toHaveLength(0);
  });

  it('a rate-limited photo gives the card back and sends nothing else', async () => {
    const h = harness({
      rotationCard: true,
      photo: { outcome: 'RATE_LIMITED', retryAfterMs: 2000 },
    });
    await rotate(h);
    expect(h.released).toEqual(['operation-1']);
    expect(h.files).toHaveLength(1);
    expect(h.edits).toHaveLength(0);
    expect(h.removed).toHaveLength(0);
  });

  it('a CARD_TEXT panel keeps the text edit, with no photo', async () => {
    const h = harness({ rotationCard: true, mode: 'CARD_TEXT' });
    await rotate(h);
    expect(h.edits).toHaveLength(1);
    expect(h.files).toHaveLength(0);
    expect(h.removed).toHaveLength(0);
  });
});
