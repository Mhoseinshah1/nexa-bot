import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APPEARANCE_SLOT_FALLBACKS,
  type AppearanceSlot,
  type BotInstanceId,
  type TemplateKey,
  type TemplateValues,
  type TenantContext,
} from '@nexa/contracts';
import { CatalogueTranslator } from '@nexa/i18n';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import { TelegramCustomerMessenger } from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  DELIVERY_TUTORIAL_TEMPLATE_KEY,
  DeliveryTutorialSender,
} from '../../apps/api/src/modules/control/client-apps/application/delivery-tutorial-sender';

/**
 * Phase 2 item 5: a premium emoji in a panel tutorial is the allowlisted `{icon:slot}` marker,
 * and it reaches Telegram as a `custom_emoji` ENTITY over the slot's fallback emoji — never as
 * raw `<tg-emoji>` and never as the marker text. The REAL catalogue renders the tutorial
 * template (`{text}` substituted verbatim) and the REAL messenger decorates it; `fetch` is the
 * only stub, so what is asserted is what reaches the wire.
 */
const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const ELIGIBLE = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const PLAIN = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const ID = '5368324170671202286';
const TEXT = '{icon:warning} کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است.';
const FALLBACK = APPEARANCE_SLOT_FALLBACKS.warning;
const DRAWN = `${FALLBACK} کاربر گرامی، اتصال سرویس فقط از طریق Sing-box امکان‌پذیر است.`;

function messenger() {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const customEmoji = new Map<AppearanceSlot, string>([['warning', ID]]);
  const appearance: AppearanceReader = {
    decorationFor: async (_s, bot) => ({ customEmoji: bot === ELIGIBLE ? customEmoji : new Map() }),
    configuredDecoration: async () => ({ customEmoji }),
    recordRuntimeRefusal: async () => undefined,
  };
  const translator = new CatalogueTranslator();
  const instance = new TelegramCustomerMessenger(
    {
      render: async (_s: unknown, key: TemplateKey, values: TemplateValues) =>
        translator.translate(key, values),
    } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async () => undefined } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    appearance,
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 9 } }) };
    }),
  );
  return { instance, calls };
}

function tutorialSender(
  m: TelegramCustomerMessenger,
  mode: 'TEXT' | 'VIDEO_TEXT',
): DeliveryTutorialSender {
  return new DeliveryTutorialSender({
    tutorials: {
      find: async () => ({
        panelId: 'panel-1',
        mode,
        text: TEXT,
        videoClientAppId: '01900000-0000-7000-8000-0000000000a1',
        appliesToPurchase: true,
        appliesToTrial: true,
        revision: 1,
        updatedAt: new Date(),
      }),
    },
    videos: { videoFor: async () => ({ fileId: 'video-file-id' }) },
    messenger: m,
    idempotency: { remember: async () => true },
    scopeActivity: { scopeIsActive: async () => true },
    uow: { run: async (_s: unknown, fn: (tx: never) => unknown) => fn({} as never) } as never,
  });
}

const SERVICE = { id: 'service-1', panelId: 'panel-1', isTrial: false };
const ENTITY = { type: 'custom_emoji', offset: 0, length: FALLBACK.length, custom_emoji_id: ID };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('premium emoji in a panel tutorial', () => {
  it('the template is the text whole: the catalogue body is `{text}`', () => {
    expect(
      new CatalogueTranslator().translate(DELIVERY_TUTORIAL_TEMPLATE_KEY, { text: TEXT }),
    ).toBe(TEXT);
  });

  it('a TEXT tutorial carries the marker as a custom_emoji entity on an eligible bot', async () => {
    const { instance, calls } = messenger();
    await tutorialSender(instance, 'TEXT').afterDelivery(scope, SERVICE, {
      chatId: '42',
      botInstanceId: ELIGIBLE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/sendMessage')).toBe(true);
    expect(calls[0]?.body).toMatchObject({ text: DRAWN, entities: [ENTITY] });
    expect(calls[0]?.body, 'plain text, no HTML parse').not.toHaveProperty('parse_mode');
    expect(String(calls[0]?.body['text'])).not.toContain('{icon:');
    expect(String(calls[0]?.body['text'])).not.toContain('tg-emoji');
  });

  it('the same text as a video CAPTION carries the same entity', async () => {
    const { instance, calls } = messenger();
    await tutorialSender(instance, 'VIDEO_TEXT').afterDelivery(scope, SERVICE, {
      chatId: '42',
      botInstanceId: ELIGIBLE,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.endsWith('/sendVideo')).toBe(true);
    expect(calls[0]?.body).toMatchObject({
      video: 'video-file-id',
      caption: DRAWN,
      caption_entities: [ENTITY],
    });
  });

  it('a bot that cannot draw premium emoji gets the fallback emoji and no entity', async () => {
    const { instance, calls } = messenger();
    await tutorialSender(instance, 'TEXT').afterDelivery(scope, SERVICE, {
      chatId: '42',
      botInstanceId: PLAIN,
    });
    expect(calls[0]?.body['text']).toBe(DRAWN);
    expect(calls[0]?.body['entities'] ?? []).toEqual([]);
  });
});
