import { describe, expect, it } from 'vitest';
import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import {
  DeliveryService,
  deliveryCardButtons,
  type DeliveryServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type {
  CustomerFileMessage,
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';

/**
 * The delivery card (customer UX completion §B), at the seam that decides what the QR
 * encodes and how the card travels. A recording encoder and a scripted messenger stand
 * in for the PNG and Telegram; the rows are a passthrough unit of work.
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const BOT = 'bot-1' as BotInstanceId;
const URL = 'https://sub.example.test/sub/0123456789abcdef0123456789abcdef';

function service(overrides: Partial<ServiceRecord> = {}): ServiceRecord {
  return {
    id: 'service-1',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    panelId: 'panel-1',
    productId: 'product-1',
    state: 'ACTIVE',
    providerUsername: 'nx7k2m9q',
    subscriptionRef: 'ref',
    providerClientId: 'client',
    providerUserId: null,
    subscriptionUrl: URL,
    expiresAt: null,
    trafficLimitBytes: 0n,
    trafficUsedBytes: 0n,
    usageSyncedAt: null,
    deliveryState: 'PENDING',
    deliveryAttempts: 0,
    deliveredAt: null,
    deliveryNextAttemptAt: null,
    deliverySendStartedAt: null,
    provisionedAt: null,
    terminatedAt: null,
    lastSeenAt: null,
    lastSeenState: null,
    customerNote: null,
    createdAt: new Date('2026-09-24T18:00:00Z'),
    updatedAt: new Date('2026-09-24T18:00:00Z'),
    ...overrides,
  } as ServiceRecord;
}

interface Script {
  readonly files: CustomerSendResult[];
  readonly texts: CustomerSendResult[];
}

function harness(script: Script) {
  const encoded: string[] = [];
  const files: CustomerFileMessage[] = [];
  const texts: CustomerMessage[] = [];
  const recorded: { from: string; to: string; sentUrl: string }[] = [];
  const deps: DeliveryServiceDeps = {
    services: {
      markSendStarted: async () => true,
      recordDelivery: async (
        _s: unknown,
        _id: unknown,
        from: string,
        to: string,
        input: { sentUrl: string },
      ) => {
        recorded.push({ from, to, sentUrl: input.sentUrl });
        return true;
      },
      recordRateLimited: async () => true,
    } as unknown as DeliveryServiceDeps['services'],
    contacts: { contactFor: async () => ({ kind: 'NO_CONTACT' }) } as never,
    messenger: {
      send: async (_s, message) => {
        texts.push(message);
        return script.texts.shift() ?? { outcome: 'DELIVERED' };
      },
      sendFile: async (_s, message) => {
        files.push(message);
        return script.files.shift() ?? { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
    },
    qr: {
      encode: (text) => {
        encoded.push(text);
        return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
      },
    },
    card: {
      factsFor: async () => ({
        productName: 'پلن پایه',
        serviceLocation: 'مولتی لوکیشن',
        durationDays: 30,
        trafficBytes: 53_687_091_200n,
      }),
    },
    scopeActivity: { scopeIsActive: async () => true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
    clock: new FixedClock(new Date('2026-09-24T18:30:00Z')),
    guard: { check: async () => undefined } as never,
  };
  return { delivery: new DeliveryService(deps), encoded, files, texts, recorded };
}

describe('the delivery card', () => {
  it('encodes the QR from the EXACT stored subscription URL and nothing else', async () => {
    const h = harness({ files: [], texts: [] });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL]);
    expect(h.files).toHaveLength(1);
    const file = h.files[0] as CustomerFileMessage;
    expect(file.kind).toBe('PHOTO');
    expect(file.source.kind).toBe('BYTES');
    expect(file.caption?.templateKey).toBe('bot.service.delivered');
    expect(file.caption?.values).toEqual({
      serviceUsername: 'nx7k2m9q',
      productName: 'پلن پایه',
      serviceLocation: 'مولتی لوکیشن',
      durationDays: 30,
      trafficBytes: 53_687_091_200n,
      subscriptionUrl: URL,
    });
    expect(file.buttons).toEqual(deliveryCardButtons('service-1'));
    expect(h.texts).toHaveLength(0);
    expect(h.recorded).toEqual([{ from: 'PENDING', to: 'DELIVERED', sentUrl: URL }]);
  });

  it('draws the three approved buttons in their order and rows', () => {
    expect(
      deliveryCardButtons('svc').map((b) => [b.label, 'data' in b ? b.data : null, b.row]),
    ).toEqual([
      [{ kind: 'TEMPLATE', key: 'bot.service.tutorial_button' }, 'tu:', 0],
      [{ kind: 'TEMPLATE', key: 'bot.service.connected_button' }, 'ok:svc', 1],
      [{ kind: 'TEMPLATE', key: 'bot.service.problem_button' }, 'sp:', 1],
    ]);
  });

  it('falls back to the photo then the card as text when the caption is over the bound, and never splits the URL', async () => {
    const h = harness({
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'DELIVERED' }],
      texts: [{ outcome: 'DELIVERED' }],
    });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL]);
    expect(h.files.map((f) => f.caption?.templateKey)).toEqual([
      'bot.service.delivered',
      'bot.service.delivered_qr_caption',
    ]);
    expect(h.files[1]?.buttons).toBeUndefined();
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]?.templateKey).toBe('bot.service.delivered');
    expect(h.texts[0]?.values['subscriptionUrl']).toBe(URL);
    expect(h.texts[0]?.buttons).toEqual(deliveryCardButtons('service-1'));
    // The URL travelled WHOLE in the text and not at all in the bare photo's caption:
    // the refused single attempt made no request (the messenger refuses before dialling).
    expect(h.files[1]?.caption?.values).toEqual({});
    expect(h.recorded.map((r) => r.to)).toEqual(['DELIVERED']);
  });

  it('records the WORST outcome: an ambiguous text after a delivered photo is UNCONFIRMED', async () => {
    const h = harness({
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'DELIVERED' }],
      texts: [{ outcome: 'UNKNOWN' }],
    });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.recorded.map((r) => r.to)).toEqual(['UNCONFIRMED']);
  });

  it('stops after a photo that did not deliver, sending no text', async () => {
    const h = harness({
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'REFUSED' }],
      texts: [],
    });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.texts).toHaveLength(0);
  });

  it('sends the plain link message when the card facts cannot be read', async () => {
    const h = harness({ files: [], texts: [] });
    (h.delivery as unknown as { deps: DeliveryServiceDeps }).deps.card.factsFor = async () => null;
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.files).toHaveLength(0);
    expect(h.texts.map((t) => t.templateKey)).toEqual(['bot.service.subscription']);
    expect(h.encoded).toEqual([]);
  });
});
