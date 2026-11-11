import { describe, expect, it } from 'vitest';
import {
  resolvePanelPolicy,
  singboxImportUrl,
  qrPayloads,
  resolveSingboxProfileName,
  normalizeSingboxCustomName,
  type SingboxNameMode,
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
  qrOptions: {
    kind: PanelQrKind;
    intervalMinutes: number;
    nameMode?: SingboxNameMode;
    nameCustom?: string | null;
  } = {
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
    qrOptions: {
      qrOptionsOf: async () => ({ nameMode: 'DEFAULT' as const, nameCustom: null, ...qrOptions }),
    },
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

describe('«نام پروفایل در sing-box»: the import URL fragment', () => {
  const base = 'https://h.test/s';
  const fragmentOf = (url: string) => url.slice(url.indexOf('#'));

  it('appends #<encoded name>, encoding Persian text, spaces, # and &', () => {
    const name = 'سرویس من #۱ & دوستان';
    const url = singboxImportUrl(base, 360, name);
    expect(url.endsWith('#' + encodeURIComponent(name))).toBe(true);
    // Only ONE fragment separator survives: the name's own # is percent-encoded.
    expect(url.split('#')).toHaveLength(2);
    expect(url).not.toMatch(/#.*[ &]/u);
    expect(decodeURIComponent(fragmentOf(url).slice(1))).toBe(name);
  });

  it('has no fragment for no name, a null name and an empty one', () => {
    for (const name of [undefined, null, '']) {
      expect(singboxImportUrl(base, 360, name)).not.toContain('#');
    }
  });

  it('only the SINGBOX payload carries the name; the plain link never changes', () => {
    const input = {
      intervalMinutes: 360,
      subscriptionUrl: SUB,
      filesOnly: false,
      profileName: 'نام',
    };
    const both = qrPayloads({ ...input, kind: 'BOTH' });
    expect(both[0]).toEqual({ kind: 'SUB_LINK', text: SUB });
    expect(both[1]?.text).toBe(singboxImportUrl(SUB, 360, 'نام'));
    expect(qrPayloads({ ...input, kind: 'SUB_LINK' })).toEqual([{ kind: 'SUB_LINK', text: SUB }]);
  });

  it('resolves: default none, USERNAME the account, CUSTOM with {username}, empty custom none', () => {
    const user = 'nx7k2m9q';
    const r = (mode: SingboxNameMode, custom: string | null) =>
      resolveSingboxProfileName({ mode, custom, username: user });
    expect(r('DEFAULT', 'ignored')).toBeNull();
    expect(r('USERNAME', null)).toBe(user);
    expect(r('CUSTOM', '  اشتراک {username}  ')).toBe(`اشتراک ${user}`);
    expect(r('CUSTOM', 'ثابت')).toBe('ثابت');
    expect(r('CUSTOM', '   ')).toBeNull();
    expect(r('CUSTOM', null)).toBeNull();
    expect(r('CUSTOM', '{username}-{username}')).toBe(`${user}-${user}`);
  });

  it('refuses a line break or more than 64 characters, trims, and stores empty as null', () => {
    expect(normalizeSingboxCustomName('  سلام  ')).toBe('سلام');
    expect(normalizeSingboxCustomName('   ')).toBeNull();
    expect(normalizeSingboxCustomName('a\nb')).toBeUndefined();
    expect(normalizeSingboxCustomName('a\u2028b')).toBeUndefined();
    expect(normalizeSingboxCustomName('x'.repeat(64))).toBe('x'.repeat(64));
    expect(normalizeSingboxCustomName('x'.repeat(65))).toBeUndefined();
    // 64 Persian letters with an emoji (a surrogate pair) count by character, not code unit.
    expect(normalizeSingboxCustomName('ب'.repeat(63) + '😀')).not.toBeUndefined();
  });
});

describe('«نام پروفایل در sing-box»: every place that draws the sing-box QR', () => {
  const opts = (
    kind: PanelQrKind,
    nameMode: SingboxNameMode,
    nameCustom: string | null = null,
  ) => ({ kind, intervalMinutes: 360, nameMode, nameCustom });
  const named = singboxImportUrl(URL, 360, 'nx7k2m9q');

  it('the delivery card draws the account name; the plain link QR stays unchanged', async () => {
    const h = harness(false, true, opts('BOTH', 'USERNAME'));
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([URL, named]);
  });

  it('the link change and the link view draw the same name', async () => {
    const changed = harness(false, true, opts('SINGBOX', 'CUSTOM', 'vpn {username}'));
    await changed.delivery.deliver(scope, service(), '5150', BOT, { rotated: true });
    expect(changed.encoded).toEqual([singboxImportUrl(URL, 360, 'vpn nx7k2m9q')]);
    const viewed = harness(false, true, opts('SINGBOX', 'CUSTOM', 'vpn {username}'), true);
    const card = { chatId: '5150', messageId: 9, botInstanceId: BOT };
    await viewed.delivery.deliver(scope, service(), '5150', BOT, { card, linkQrKey: 'tap-9' });
    expect(viewed.encoded).toEqual([singboxImportUrl(URL, 360, 'vpn nx7k2m9q')]);
    // The link text is the link itself, never the sing-box string or its name.
    expect(JSON.stringify(viewed.files[0])).toContain(URL);
  });

  it('the mini app sheet (qrPayloadsFor) resolves the same name', async () => {
    const h = harness(false, true, opts('BOTH', 'CUSTOM', 'vpn {username}'));
    expect(await h.delivery.qrPayloadsFor(scope, service())).toEqual([
      { kind: 'SUB_LINK', text: URL },
      { kind: 'SINGBOX', text: singboxImportUrl(URL, 360, 'vpn nx7k2m9q') },
    ]);
  });

  it('the default and an empty custom text draw no fragment — today, for every panel', async () => {
    for (const o of [opts('SINGBOX', 'DEFAULT'), opts('SINGBOX', 'CUSTOM', null)]) {
      const h = harness(false, true, o);
      await h.delivery.deliver(scope, service(), '5150', BOT);
      expect(h.encoded).toEqual([singboxImportUrl(URL, 360)]);
      expect(h.encoded[0]).not.toContain('#sub');
      expect(h.encoded[0]?.includes('#')).toBe(false);
    }
  });

  it('files-only still wins: no name, no QR', async () => {
    const h = harness(true, true, opts('SINGBOX', 'USERNAME'));
    await h.delivery.deliver(scope, service(), '5150', BOT);
    expect(h.encoded).toEqual([]);
  });
});
