import { describe, expect, it } from 'vitest';
import {
  resolvePanelPolicy,
  updateDeliveryTutorialRequestSchema,
  deliveryTutorialTextProblem,
  type BotInstanceId,
  type DeliveryTutorialMode,
  type TenantContext,
} from '@nexa/contracts';
import {
  DELIVERY_TUTORIAL_TEMPLATE_KEY,
  DeliveryTutorialSender,
  deliveryTutorialClaimKey,
} from '../../apps/api/src/modules/control/client-apps/application/delivery-tutorial-sender';
import type { DeliveryTutorialRecord } from '../../apps/api/src/modules/control/client-apps/application/delivery-tutorial.service';
import {
  DeliveryService,
  type DeliveryServiceDeps,
} from '../../apps/api/src/modules/commerce/provisioning/application/delivery.service';
import type { ServiceRecord } from '../../apps/api/src/modules/commerce/provisioning/application/ports';
import type {
  CustomerFileMessage,
  CustomerMessage,
  CustomerSendResult,
} from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { PngQrCodeEncoder } from '../../apps/api/src/infrastructure/qr/qr-png';
import { FixedClock } from '../../apps/api/src/infrastructure/clock';

/**
 * Phase 2 item 5: the panel's tutorial after a delivery — the sender's arrangements, its
 * at-most-once claim, and the delivery sweep's hook that calls it only for a FIRST delivery.
 * A scripted messenger stands in for Telegram and an in-memory set for the idempotency store
 * (its SQL is exercised end to end in `tests/integration/delivery-tutorial.test.ts`).
 */
const scope = { tenantId: 'tenant-1', botInstanceId: null } as unknown as TenantContext;
const BOT = 'bot-1' as BotInstanceId;
const CONTACT = { chatId: '5150', botInstanceId: BOT };
const TEXT = 'کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است.';
const APP = '01900000-0000-7000-8000-0000000000a1';

function tutorial(overrides: Partial<DeliveryTutorialRecord> = {}): DeliveryTutorialRecord {
  return {
    panelId: 'panel-1',
    mode: 'TEXT',
    text: TEXT,
    videoClientAppId: APP,
    appliesToPurchase: true,
    appliesToTrial: true,
    revision: 1,
    updatedAt: new Date('2026-10-06T00:00:00Z'),
    ...overrides,
  };
}

const PAID = { id: 'service-1', panelId: 'panel-1', isTrial: false };
const TRIAL = { id: 'service-2', panelId: 'panel-1', isTrial: true };

function sender(
  options: {
    readonly row?: DeliveryTutorialRecord | null;
    readonly video?: string | null;
    readonly files?: CustomerSendResult[];
    readonly texts?: CustomerSendResult[];
    readonly active?: boolean;
    readonly claimed?: Set<string>;
  } = {},
) {
  const order: string[] = [];
  const files: CustomerFileMessage[] = [];
  const texts: CustomerMessage[] = [];
  const claimed = options.claimed ?? new Set<string>();
  const scriptFiles = [...(options.files ?? [])];
  const scriptTexts = [...(options.texts ?? [])];
  const videoFor: { app: string; bot: BotInstanceId }[] = [];
  const instance = new DeliveryTutorialSender({
    tutorials: { find: async () => (options.row === undefined ? tutorial() : options.row) },
    videos: {
      videoFor: async (_s, app, bot) => {
        videoFor.push({ app, bot });
        const fileId = options.video === undefined ? 'video-file-id' : options.video;
        return fileId === null ? null : { fileId };
      },
    },
    messenger: {
      send: async (_s, message) => {
        order.push('send');
        texts.push(message);
        return scriptTexts.shift() ?? { outcome: 'DELIVERED' };
      },
      sendFile: async (_s, message) => {
        order.push('sendFile');
        files.push(message);
        return scriptFiles.shift() ?? { outcome: 'DELIVERED' };
      },
    },
    idempotency: {
      remember: async (_s, namespace, key) => {
        order.push(`claim:${namespace}:${key}`);
        if (claimed.has(key)) return false;
        claimed.add(key);
        return true;
      },
    },
    scopeActivity: { scopeIsActive: async () => options.active ?? true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
  });
  return { instance, order, files, texts, claimed, videoFor };
}

describe('the panel tutorial after delivery — what is sent', () => {
  it('sends nothing, and claims nothing, for a panel with no tutorial', async () => {
    const h = sender({ row: null });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({ kind: 'NONE' });
    expect(h.order).toEqual([]);
  });

  it('sends nothing for a DISABLED tutorial, though its text and video are kept', async () => {
    const h = sender({ row: tutorial({ mode: 'DISABLED' }) });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({ kind: 'NONE' });
    expect(h.order).toEqual([]);
  });

  it('TEXT: one message through the tutorial template, its body the text whole', async () => {
    const h = sender({ row: tutorial({ mode: 'TEXT' }) });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'TEXT',
      outcome: 'DELIVERED',
    });
    expect(h.files).toHaveLength(0);
    expect(h.texts).toEqual([
      {
        chatId: '5150',
        botInstanceId: BOT,
        templateKey: DELIVERY_TUTORIAL_TEMPLATE_KEY,
        values: { text: TEXT },
      },
    ]);
    expect(h.videoFor, 'a TEXT tutorial never reads a video').toHaveLength(0);
  });

  it('draws the text with the client-app guide renderer (bullets, links)', async () => {
    const h = sender({
      row: tutorial({ text: '- نصب Sing-box\n[دانلود](https://example.com/app)' }),
    });
    await h.instance.afterDelivery(scope, PAID, CONTACT);
    expect(h.texts[0]?.values).toEqual({
      text: '• نصب Sing-box\nدانلود: https://example.com/app',
    });
  });

  it('VIDEO: one bare video by the file_id THIS bot holds, and no text', async () => {
    const h = sender({ row: tutorial({ mode: 'VIDEO' }) });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'VIDEO',
      outcome: 'DELIVERED',
    });
    expect(h.videoFor).toEqual([{ app: APP, bot: BOT }]);
    expect(h.texts).toHaveLength(0);
    expect(h.files).toHaveLength(1);
    expect(h.files[0]).toEqual({
      chatId: '5150',
      botInstanceId: BOT,
      kind: 'VIDEO',
      source: { kind: 'FILE_ID', fileId: 'video-file-id' },
    });
  });

  it('VIDEO_TEXT that fits: ONE video with the text as its whole caption', async () => {
    const h = sender({ row: tutorial({ mode: 'VIDEO_TEXT' }) });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'VIDEO_CAPTIONED',
      outcome: 'DELIVERED',
    });
    expect(h.texts).toHaveLength(0);
    expect(h.files).toHaveLength(1);
    expect(h.files[0]?.caption).toEqual({
      templateKey: DELIVERY_TUTORIAL_TEMPLATE_KEY,
      values: { text: TEXT },
    });
    expect(h.files[0]?.captionWhole, 'never a cut caption').toBe(true);
  });

  it('VIDEO_TEXT too long for a caption: the bare video, then the text whole', async () => {
    const h = sender({
      row: tutorial({ mode: 'VIDEO_TEXT' }),
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'DELIVERED' }],
    });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'VIDEO_THEN_TEXT',
      outcome: 'DELIVERED',
    });
    expect(h.files).toHaveLength(2);
    expect(h.files[1]?.caption, 'the second video is bare').toBeUndefined();
    expect(h.texts.map((m) => m.values)).toEqual([{ text: TEXT }]);
    expect(h.order.slice(-3)).toEqual(['sendFile', 'sendFile', 'send']);
  });

  it('VIDEO_TEXT too long whose bare video is RATE_LIMITED: no text bursts into the limit', async () => {
    const h = sender({
      row: tutorial({ mode: 'VIDEO_TEXT' }),
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'RATE_LIMITED' }],
    });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'VIDEO_THEN_TEXT',
      outcome: 'RATE_LIMITED',
    });
    expect(h.files).toHaveLength(2);
    expect(h.texts, 'the text is not sent into the same per-chat limit').toHaveLength(0);
  });

  it('VIDEO_TEXT too long whose bare video is UNKNOWN: the text still follows', async () => {
    const h = sender({
      row: tutorial({ mode: 'VIDEO_TEXT' }),
      files: [{ outcome: 'REFUSED', reason: 'CAPTION_OVER_BOUND' }, { outcome: 'UNKNOWN' }],
    });
    await h.instance.afterDelivery(scope, PAID, CONTACT);
    expect(h.texts).toHaveLength(1);
  });

  it('VIDEO_TEXT whose video Telegram refuses: the text still goes, once', async () => {
    const h = sender({ row: tutorial({ mode: 'VIDEO_TEXT' }), files: [{ outcome: 'REFUSED' }] });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'TEXT',
      outcome: 'DELIVERED',
    });
    expect(h.files).toHaveLength(1);
    expect(h.texts).toHaveLength(1);
  });

  it.each(['UNKNOWN', 'RATE_LIMITED'] as const)(
    'VIDEO_TEXT answered %s is neither retried nor followed by the text',
    async (outcome) => {
      const h = sender({ row: tutorial({ mode: 'VIDEO_TEXT' }), files: [{ outcome }] });
      expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
        kind: 'SENT',
        arrangement: 'VIDEO_CAPTIONED',
        outcome,
      });
      expect(h.files).toHaveLength(1);
      expect(h.texts).toHaveLength(0);
    },
  );

  it.each(['UNKNOWN', 'RATE_LIMITED'] as const)(
    'TEXT answered %s is not retried, and a later call finds the claim',
    async (outcome) => {
      const h = sender({ texts: [{ outcome }] });
      await h.instance.afterDelivery(scope, PAID, CONTACT);
      expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({ kind: 'DUPLICATE' });
      expect(h.texts).toHaveLength(1);
    },
  );

  it('VIDEO_TEXT whose bot holds no video sends the text alone', async () => {
    const h = sender({ row: tutorial({ mode: 'VIDEO_TEXT' }), video: null });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'SENT',
      arrangement: 'TEXT',
      outcome: 'DELIVERED',
    });
    expect(h.files).toHaveLength(0);
  });

  it('VIDEO whose bot holds no video sends nothing, and claims nothing', async () => {
    const h = sender({ row: tutorial({ mode: 'VIDEO' }), video: null });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({ kind: 'NONE' });
    expect(h.order).toEqual([]);
  });
});

describe('the panel tutorial after delivery — purchase, trial, once', () => {
  it('a purchase-only tutorial is sent for a paid service and not for a trial', async () => {
    const row = tutorial({ appliesToTrial: false });
    expect((await sender({ row }).instance.afterDelivery(scope, PAID, CONTACT)).kind).toBe('SENT');
    expect(await sender({ row }).instance.afterDelivery(scope, TRIAL, CONTACT)).toEqual({
      kind: 'NONE',
    });
  });

  it('a trial-only tutorial is sent for a trial and not for a paid service', async () => {
    const row = tutorial({ appliesToPurchase: false });
    expect((await sender({ row }).instance.afterDelivery(scope, TRIAL, CONTACT)).kind).toBe('SENT');
    expect(await sender({ row }).instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'NONE',
    });
  });

  it('claims the service in the WORKER namespace BEFORE sending, and a replay sends nothing', async () => {
    const claimed = new Set<string>();
    const first = sender({ claimed });
    await first.instance.afterDelivery(scope, PAID, CONTACT);
    expect(first.order).toEqual([`claim:WORKER:${deliveryTutorialClaimKey(PAID.id)}`, 'send']);
    // A second replica, or the same update replayed: the claim stands, nothing goes.
    const replay = sender({ claimed });
    expect(await replay.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({
      kind: 'DUPLICATE',
    });
    expect(replay.texts).toHaveLength(0);
    expect(replay.files).toHaveLength(0);
  });

  it('each service gets its own tutorial: the claim is keyed by the service', async () => {
    const claimed = new Set<string>();
    const h = sender({ claimed });
    await h.instance.afterDelivery(scope, PAID, CONTACT);
    expect((await h.instance.afterDelivery(scope, TRIAL, CONTACT)).kind).toBe('SENT');
    expect(h.texts).toHaveLength(2);
    expect([...claimed]).toEqual([
      deliveryTutorialClaimKey(PAID.id),
      deliveryTutorialClaimKey(TRIAL.id),
    ]);
  });

  it('a stopped tenant: nothing claimed, nothing sent', async () => {
    const h = sender({ active: false });
    expect(await h.instance.afterDelivery(scope, PAID, CONTACT)).toEqual({ kind: 'STOPPED' });
    expect(h.claimed.size).toBe(0);
    expect(h.texts).toHaveLength(0);
  });
});

// --- The delivery sweep's hook ---------------------------------------------------------------

const URL = 'https://sub.example.test/sub/0123456789abcdef0123456789abcdef?name=nx7k2m9q';

function pending(): ServiceRecord {
  return {
    id: 'service-1',
    tenantId: 'tenant-1',
    customerId: 'customer-1',
    orderId: 'order-1',
    panelId: 'panel-1',
    productId: 'product-1',
    isTrial: false,
    state: 'ACTIVE',
    providerUsername: 'nx7k2m9q',
    subscriptionUrl: URL,
    deliveryState: 'PENDING',
    deliveryAttempts: 0,
    deliveredAt: null,
    deliverySendStartedAt: null,
  } as unknown as ServiceRecord;
}

function sweep(options: { rotated?: boolean; card?: CustomerSendResult } = {}) {
  const calls: string[] = [];
  const deps: DeliveryServiceDeps = {
    services: {
      reapStrandedSends: async () => 0,
      claimDeliveryDue: async () => [pending()],
      markSendStarted: async () => true,
      recordDelivery: async () => true,
      recordRateLimited: async () => true,
    } as unknown as DeliveryServiceDeps['services'],
    contacts: {
      contactFor: async () => ({ kind: 'FOUND', contact: { chatId: '5150', botInstanceId: BOT } }),
    } as never,
    messenger: {
      send: async () => {
        calls.push('card');
        return options.card ?? { outcome: 'DELIVERED' };
      },
      sendFile: async () => {
        calls.push('card');
        return options.card ?? { outcome: 'DELIVERED' };
      },
      acknowledge: async () => undefined,
    },
    qr: new PngQrCodeEncoder(),
    card: { factsFor: async () => null },
    scopeActivity: { scopeIsActive: async () => true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
    clock: new FixedClock(new Date('2026-10-06T00:00:00Z')),
    guard: { check: async () => undefined } as never,
    panelPolicy: {
      forPanel: async () => resolvePanelPolicy({ delivery: { mode: 'CARD_TEXT' }, actions: {} }),
    },
    files: {
      afterDelivery: async () => {
        calls.push('files');
      },
    },
    rotations: { hasRotated: async () => options.rotated === true },
    tutorial: {
      afterDelivery: async (_s, service, contact) => {
        calls.push(`tutorial:${service.id}:${contact.chatId}`);
      },
    },
  };
  return { delivery: new DeliveryService(deps), calls, deps };
}

describe('the delivery sweep calls the tutorial', () => {
  it('after the files, for the FIRST delivery it recorded', async () => {
    const h = sweep();
    const report = await h.delivery.deliverDue(scope, 10);
    expect(report.delivered).toBe(1);
    expect(h.calls).toEqual(['card', 'files', 'tutorial:service-1:5150']);
  });

  it('never for a rotation’s new link', async () => {
    const h = sweep({ rotated: true });
    await h.delivery.deliverDue(scope, 10);
    expect(h.calls).toEqual(['card', 'files']);
  });

  it('never when the card was not delivered', async () => {
    const h = sweep({ card: { outcome: 'UNKNOWN' } });
    await h.delivery.deliverDue(scope, 10);
    expect(h.calls).toEqual(['card']);
  });

  it('never for a customer asking again (redeliver)', async () => {
    const h = sweep();
    await h.delivery.redeliver(scope, pending(), 'customer-1' as never, '5150', BOT);
    expect(h.calls, 'the link was sent again').toContain('card');
    expect(h.calls.filter((c) => c.startsWith('tutorial'))).toEqual([]);
  });

  it('a tutorial that throws changes nothing in the sweep', async () => {
    const h = sweep();
    const throwing = new DeliveryService({
      ...h.deps,
      tutorial: {
        afterDelivery: async () => {
          throw new Error('tutorial broke');
        },
      },
    });
    const report = await throwing.deliverDue(scope, 10);
    expect(report).toMatchObject({ delivered: 1, errored: 0 });
  });
});

// --- The contract ---------------------------------------------------------------------------

describe('the tutorial request contract', () => {
  const base = {
    idempotencyKey: 'key-12345678',
    expectedRevision: 0,
    mode: 'TEXT' as DeliveryTutorialMode,
    text: TEXT,
    videoClientAppId: null,
    appliesToPurchase: true,
    appliesToTrial: true,
  };

  it('accepts the owner’s example as TEXT, and keeps unused fields as sent', () => {
    expect(updateDeliveryTutorialRequestSchema.parse(base).text).toBe(TEXT);
    const disabled = updateDeliveryTutorialRequestSchema.parse({
      ...base,
      mode: 'DISABLED',
      videoClientAppId: APP,
    });
    expect(disabled).toMatchObject({ text: TEXT, videoClientAppId: APP });
  });

  it('refuses a mode without what it sends', () => {
    expect(updateDeliveryTutorialRequestSchema.safeParse({ ...base, text: '  ' }).success).toBe(
      false,
    );
    expect(updateDeliveryTutorialRequestSchema.safeParse({ ...base, mode: 'VIDEO' }).success).toBe(
      false,
    );
    expect(
      updateDeliveryTutorialRequestSchema.safeParse({
        ...base,
        appliesToPurchase: false,
        appliesToTrial: false,
      }).success,
    ).toBe(false);
  });

  it('refuses raw markup (<tg-emoji>) and an unknown icon marker; accepts a known one', () => {
    expect(
      deliveryTutorialTextProblem('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>'),
    ).toBe('MARKUP');
    expect(deliveryTutorialTextProblem('{icon:paymnt} hi')).toBe('UNKNOWN_ICON');
    expect(deliveryTutorialTextProblem('{icon:payment} hi')).toBeNull();
    expect(deliveryTutorialTextProblem('see http://insecure.example')).toBe('UNSAFE_LINK');
    expect(deliveryTutorialTextProblem('x'.repeat(2501))).toBe('TOO_LONG');
  });
});
