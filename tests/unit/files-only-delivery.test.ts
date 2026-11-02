import { describe, expect, it } from 'vitest';
import {
  resolvePanelPolicy,
  singboxImportUrl,
  qrPayloads,
  type PanelQrKind,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import {
  DeliveryService,
  deliveryCardButtons,
  type DeliveryServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type {
  CustomerFileMessage,
  CustomerMessage,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';

/**
 * R11 A4, at the seam that decides what a delivery shows: on a «فقط فایل، بدون لینک ساب»
 * panel no message the delivery sends carries the link or a QR of it, and the link VIEW is
 * refused before anything is stamped or sent. The same inputs with the option off are the
 * controls.
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
    originalStartedAt: new Date('2026-09-24T18:00:00Z'),
    createdAt: new Date('2026-09-24T18:00:00Z'),
    updatedAt: new Date('2026-09-24T18:00:00Z'),
    ...overrides,
  } as ServiceRecord;
}

function harness(
  filesOnly: boolean,
  facts: boolean = true,
  qrOptions: { kind: PanelQrKind; intervalMinutes: number } = {
    kind: 'SUB_LINK',
    intervalMinutes: 360,
  },
  withLinkClaims = false,
) {
  const encoded: string[] = [];
  const files: CustomerFileMessage[] = [];
  const texts: CustomerMessage[] = [];
  const edits: unknown[] = [];
  let stamped = 0;
  const deps: DeliveryServiceDeps = {
    services: {
      markSendStarted: async () => {
        stamped += 1;
        return true;
      },
      recordDelivery: async () => true,
      recordRateLimited: async () => true,
    } as unknown as DeliveryServiceDeps['services'],
    contacts: { contactFor: async () => ({ kind: 'NO_CONTACT' }) } as never,
    messenger: {
      send: async (_s: unknown, message: CustomerMessage) => {
        texts.push(message);
        return { outcome: 'DELIVERED' };
      },
      sendFile: async (_s: unknown, message: CustomerFileMessage) => {
        files.push(message);
        return { outcome: 'DELIVERED' };
      },
      edit: async (_s: unknown, message: unknown) => {
        edits.push(message);
        return { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
    } as never,
    qr: {
      render: async (_s, source) => {
        encoded.push(source.kind === 'PAYLOAD' ? source.text : '<provider image>');
        return {
          bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
          origin: 'NEXA_GENERATED',
          templated: false,
        };
      },
    },
    card: {
      factsFor: async () =>
        facts
          ? {
              productName: 'پلن پایه',
              serviceLocation: null,
              durationDays: 30,
              trafficBytes: 53_687_091_200n,
            }
          : null,
    },
    scopeActivity: { scopeIsActive: async () => true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
    clock: new FixedClock(new Date('2026-09-24T18:30:00Z')),
    guard: { check: async () => undefined } as never,
    panelPolicy: {
      forPanel: async () => resolvePanelPolicy({ delivery: { mode: 'CARD_WITH_QR' }, actions: {} }),
    },
    filesOnly: { isFilesOnly: async () => filesOnly },
    qrOptions: { qrOptionsOf: async () => qrOptions },
    ...(withLinkClaims ? { linkQr: { claim: async () => true } } : {}),
  };
  return {
    delivery: new DeliveryService(deps),
    encoded,
    files,
    texts,
    edits,
    stamped: () => stamped,
  };
}

const everything = (h: ReturnType<typeof harness>) =>
  JSON.stringify([h.texts, h.files, h.edits], (_k, v: unknown) =>
    typeof v === 'bigint' ? v.toString() : v,
  );

describe('delivery on a files-only panel', () => {
  it('sends the card with no link, no QR render and no photo', async () => {
    const h = harness(true);
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([]);
    expect(h.files).toEqual([]);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatchObject({ templateKey: 'bot.service.delivered_files_only' });
    expect(everything(h)).not.toContain(URL);
    expect(h.texts[0]?.buttons).toEqual(deliveryCardButtons('service-1'));
  });

  it('sends the card with only the username when its facts cannot be read', async () => {
    const h = harness(true, false);
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.texts[0]).toMatchObject({
      templateKey: 'bot.service.delivered_files_only',
      values: { serviceUsername: 'nx7k2m9q' },
    });
    expect(everything(h)).not.toContain(URL);
  });

  it('control: the same delivery with the option off draws the QR of the link', async () => {
    const h = harness(false);
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL]);
    expect(everything(h)).toContain(URL);
  });

  it('answers a link change with the files text: no link, no QR, a way back', async () => {
    const h = harness(true);
    await h.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });
    expect(h.encoded).toEqual([]);
    expect(h.files).toEqual([]);
    expect(h.texts[0]).toMatchObject({
      templateKey: 'bot.service.files_renewed',
      values: { serviceUsername: 'nx7k2m9q' },
    });
    expect(everything(h)).not.toContain(URL);
  });

  it('control: the same link change with the option off carries the new link', async () => {
    const h = harness(false);
    await h.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });
    expect(everything(h)).toContain(URL);
  });

  it('refuses the link VIEW before stamping or sending anything', async () => {
    const h = harness(true);
    const card = { chatId: '5150', messageId: 9, botInstanceId: BOT };
    await expect(
      h.delivery.deliver(scope, service(), '5150', BOT, { card, linkQrKey: 'k' }),
    ).rejects.toMatchObject({
      code: 'commerce.service_not_deliverable',
      details: { reason: 'FILES_ONLY' },
    });
    expect(h.stamped()).toBe(0);
    expect(h.texts).toEqual([]);
    expect(h.files).toEqual([]);
    expect(h.edits).toEqual([]);
  });

  it('control: the link view works with the option off', async () => {
    const h = harness(false);
    const card = { chatId: '5150', messageId: 9, botInstanceId: BOT };
    await h.delivery.deliver(scope, service(), '5150', BOT, { card });
    expect(everything(h)).toContain(URL);
  });
});

const SUB = 'https://sub.example.test/sub/abc?token=1&x=a b#frag';
const SINGBOX_360 =
  'sing-box://import-remote-profile?url=https%3A%2F%2Fsub.example.test%2Fsub%2Fabc%3Ftoken%3D1%26x%3Da%20b%23frag&autoUpdate=true&autoUpdateInterval=360';

describe('«نوع بارکد»: the sing-box import string', () => {
  it('encodes the whole link, so ? & # = and spaces cannot become parameters of the URL', () => {
    expect(singboxImportUrl(SUB, 360)).toBe(SINGBOX_360);
    // The link survives a round trip through the one parameter it was put in.
    const url = new globalThis.URL(singboxImportUrl(SUB, 360).replace('sing-box://', 'https://'));
    expect(url.searchParams.get('url')).toBe(SUB);
    expect([...url.searchParams.keys()]).toEqual(['url', 'autoUpdate', 'autoUpdateInterval']);
  });

  it('writes the interval as given: the default 360 and a custom 90', () => {
    expect(singboxImportUrl('https://h.test/s', 360)).toBe(
      'sing-box://import-remote-profile?url=https%3A%2F%2Fh.test%2Fs&autoUpdate=true&autoUpdateInterval=360',
    );
    expect(singboxImportUrl('https://h.test/s', 90)).toContain('&autoUpdateInterval=90');
  });

  it('picks the QRs by kind, link first, and none at all while files-only is on', () => {
    const input = { intervalMinutes: 360, subscriptionUrl: SUB, filesOnly: false };
    expect(qrPayloads({ ...input, kind: 'SUB_LINK' })).toEqual([{ kind: 'SUB_LINK', text: SUB }]);
    expect(qrPayloads({ ...input, kind: 'SINGBOX' })).toEqual([
      { kind: 'SINGBOX', text: SINGBOX_360 },
    ]);
    expect(qrPayloads({ ...input, kind: 'BOTH' })).toEqual([
      { kind: 'SUB_LINK', text: SUB },
      { kind: 'SINGBOX', text: SINGBOX_360 },
    ]);
    for (const kind of ['SUB_LINK', 'SINGBOX', 'BOTH'] as const) {
      expect(qrPayloads({ ...input, kind, filesOnly: true }), kind).toEqual([]);
    }
  });
});

describe('«نوع بارکد»: what the delivery draws', () => {
  const captionKeys = (h: ReturnType<typeof harness>) =>
    h.files.map((file) => (file as { caption?: { templateKey: string } }).caption?.templateKey);

  it('SINGBOX: the card photo encodes the sing-box string, not the link', async () => {
    const h = harness(false, true, { kind: 'SINGBOX', intervalMinutes: 90 });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([singboxImportUrl(URL, 90)]);
  });

  it('SUB_LINK (the default): exactly the link, as before', async () => {
    const h = harness(false);
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL]);
  });

  it('BOTH: two photos in order, each with its own one-line caption, then the whole card', async () => {
    const h = harness(false, true, { kind: 'BOTH', intervalMinutes: 360 });
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL, singboxImportUrl(URL, 360)]);
    expect(captionKeys(h)).toEqual([
      'bot.service.qr_caption_sublink',
      'bot.service.qr_caption_singbox',
    ]);
    expect(h.texts).toHaveLength(1);
    expect(h.texts[0]).toMatchObject({ templateKey: 'bot.service.delivered' });
  });

  it('files-only wins over every kind: no render, no photo, no link', async () => {
    for (const kind of ['SUB_LINK', 'SINGBOX', 'BOTH'] as const) {
      const h = harness(true, true, { kind, intervalMinutes: 360 });
      await h.delivery.deliver(scope, service(), '5150', BOT);
      expect(h.encoded, kind).toEqual([]);
      expect(h.files, kind).toEqual([]);
      expect(everything(h), kind).not.toContain(URL);
      expect(everything(h), kind).not.toContain('sing-box');
      const rotated = harness(true, true, { kind, intervalMinutes: 360 });
      await rotated.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });
      expect(rotated.encoded, kind).toEqual([]);
      expect(rotated.files, kind).toEqual([]);
    }
  });

  it('BOTH on the link view: the link as text on the card, then the two captioned QRs', async () => {
    const h = harness(false, true, { kind: 'BOTH', intervalMinutes: 360 }, true);
    const card = { chatId: '5150', messageId: 9, botInstanceId: BOT };
    await h.delivery.deliver(scope, service(), '5150', BOT, { card, linkQrKey: 'tap-1' });
    expect(h.edits).toHaveLength(1);
    expect(JSON.stringify(h.edits[0])).toContain(URL);
    expect(h.encoded).toEqual([URL, singboxImportUrl(URL, 360)]);
    expect(captionKeys(h)).toEqual([
      'bot.service.qr_caption_sublink',
      'bot.service.qr_caption_singbox',
    ]);
  });

  it('SINGBOX on the link view: one photo of the sing-box string, the link as its caption', async () => {
    const h = harness(false, true, { kind: 'SINGBOX', intervalMinutes: 360 }, true);
    const card = { chatId: '5150', messageId: 9, botInstanceId: BOT };
    await h.delivery.deliver(scope, service(), '5150', BOT, { card, linkQrKey: 'tap-2' });
    expect(h.encoded).toEqual([singboxImportUrl(URL, 360)]);
    expect(h.files).toHaveLength(1);
    expect(JSON.stringify(h.files[0])).toContain(URL);
  });

  it('BOTH on a link change: the text answer, then the two captioned QRs', async () => {
    const h = harness(false, true, { kind: 'BOTH', intervalMinutes: 360 });
    await h.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });
    expect(h.texts[0]).toMatchObject({ templateKey: 'bot.service.link_rotated' });
    expect(h.encoded).toEqual([URL, singboxImportUrl(URL, 360)]);
    expect(captionKeys(h)).toEqual([
      'bot.service.qr_caption_sublink',
      'bot.service.qr_caption_singbox',
    ]);
  });
});
