import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppearanceSlot,
  BotInstanceId,
  InlineButtonIcons,
  InlineButtonStyles,
  TenantContext,
} from '@nexa/contracts';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import type { CustomerButton } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  inlineDataLabel,
  inlineLabel,
} from '../../apps/api/src/modules/commerce/messaging/application/inline-buttons';
import {
  NO_DECORATION,
  mayCarryCustomEmoji,
} from '../../apps/api/src/modules/commerce/messaging/application/appearance-render';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  TelegramCustomerMessenger,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  buttonsHaveIcons,
  telegramButtonMarkup,
  withoutButtonIcons,
  type TelegramButton,
} from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * Phase 2 UX wave, Item 3 — the optional premium icon on a customer INLINE button
 * (`bot.inline_button_icons`), on the wire.
 *
 * `fetch` is stubbed, as `telegram-reply-keyboard-wire.test.ts` stubs it: what is under test
 * is what reaches the wire and how many times. A stub can only prove this code agrees with
 * itself; `InlineKeyboardButton.icon_custom_emoji_id` is taken from the Bot API's published
 * types (`@grammyjs/types`), and a real-bot acceptance is still owed (`OQ-P2-ICON-01`).
 */

const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const eligibleBot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const untestedBot = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const ICON = '5368324170671202286';
const OTHER_ICON = '5368324170671202287';
const OK = { status: 200, body: { ok: true, result: { message_id: 7 } } };
const DENIAL = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
};
const GENERIC = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: BUTTON_TYPE_INVALID' },
};
type Answer = { status: number; body: unknown } | 'TIMEOUT' | 'GARBLED';

/** A reader that decorates only `eligible` bots, with NO slot configured: an icon is not a slot. */
function reader(eligible: readonly BotInstanceId[]) {
  const refused: BotInstanceId[] = [];
  const appearance: AppearanceReader = {
    decorationFor: async (_scope, botInstanceId) =>
      eligible.includes(botInstanceId)
        ? { customEmoji: new Map<AppearanceSlot, string>(), eligible: true }
        : NO_DECORATION,
    configuredDecoration: async () => ({ customEmoji: new Map(), eligible: true }),
    recordRuntimeRefusal: async (_scope, botInstanceId) => {
      refused.push(botInstanceId);
    },
  };
  return { appearance, refused };
}

function harness(
  options: {
    readonly icons?: InlineButtonIcons;
    readonly styles?: InlineButtonStyles;
    readonly eligible?: readonly BotInstanceId[];
    readonly noIconReader?: boolean;
  } = {},
) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const events: { code: string; context?: Record<string, unknown> }[] = [];
  let iconReads = 0;
  const { appearance, refused } = reader(options.eligible ?? [eligibleBot]);
  const messenger = new TelegramCustomerMessenger(
    { render: async (_scope: unknown, key: string) => `label:${key}` } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async (_scope: unknown, event: { code: string }) => events.push(event) } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    appearance,
    {
      stylesFor: async () => options.styles ?? {},
      ...(options.noIconReader === true
        ? {}
        : {
            iconsFor: async () => {
              iconReads += 1;
              return options.icons ?? {};
            },
          }),
    },
  );
  const respondWith = (answers: readonly Answer[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        if (answer === undefined) throw new Error('no answer scripted');
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        if (answer === 'TIMEOUT') throw new Error('The operation was aborted due to timeout');
        if (answer === 'GARBLED') {
          return {
            ok: true,
            status: 200,
            json: async () => {
              throw new SyntaxError('Unexpected end of JSON input');
            },
          };
        }
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }),
    );
  return { messenger, calls, events, refused, respondWith, iconReads: () => iconReads };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Every route kind: a callback, a copy, a URL, a data-labelled callback, a non-registry button. */
const KEYBOARD: readonly CustomerButton[] = [
  { ...inlineLabel('payment.sent'), data: 'i:payment', row: 0 },
  { ...inlineLabel('payment.copy_card'), copyText: '6037991234567890', row: 0 },
  { ...inlineLabel('payment.gateway_pay'), url: 'https://pay.example/x' },
  { ...inlineDataLabel('catalog.category', { kind: 'TEXT', text: 'VPN' }), data: 'c:1' },
  { label: { kind: 'TEXT', text: 'free' }, data: 'free:1' },
];

const keyboardOf = (body: Record<string, unknown> | undefined) =>
  (body?.['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] } | undefined)
    ?.inline_keyboard;
const routesOf = (body: Record<string, unknown> | undefined) =>
  (keyboardOf(body) ?? []).map((row) =>
    row.map((cell) => {
      const { icon_custom_emoji_id: _icon, ...route } = cell;
      return route;
    }),
  );
const iconsOf = (body: Record<string, unknown> | undefined) =>
  (keyboardOf(body) ?? []).flat().map((cell) => cell['icon_custom_emoji_id'] ?? null);

const send = (
  messenger: TelegramCustomerMessenger,
  botInstanceId: BotInstanceId = eligibleBot,
  buttons: readonly CustomerButton[] = KEYBOARD,
) =>
  messenger.send(scope, {
    chatId: '42',
    botInstanceId,
    templateKey: 'bot.payment.receipt_prompt',
    values: { minutes: 5 },
    buttons,
  });

describe('the inline-button icon descriptor (send-message.ts)', () => {
  it('writes icon_custom_emoji_id beside an unaltered text and route, for every route kind', () => {
    const buttons: TelegramButton[] = [
      { text: 'a', data: 'x', style: 'success', iconCustomEmojiId: ICON },
      { text: 'b', copyText: 'c', iconCustomEmojiId: ICON },
      { text: 'c', url: 'https://e.example', iconCustomEmojiId: ICON },
    ];
    expect(telegramButtonMarkup(buttons)).toEqual([
      [{ text: 'a', callback_data: 'x', style: 'success', icon_custom_emoji_id: ICON }],
      [{ text: 'b', copy_text: { text: 'c' }, icon_custom_emoji_id: ICON }],
      [{ text: 'c', url: 'https://e.example', icon_custom_emoji_id: ICON }],
    ]);
  });

  it('never sends an empty icon, and a button without one is byte for byte as before', () => {
    expect(
      JSON.stringify(telegramButtonMarkup([{ text: 'a', data: 'x', iconCustomEmojiId: '' }])),
    ).toBe(JSON.stringify([[{ text: 'a', callback_data: 'x' }]]));
    expect(JSON.stringify(telegramButtonMarkup([{ text: 'a', data: 'x' }]))).toBe(
      JSON.stringify([[{ text: 'a', callback_data: 'x' }]]),
    );
  });

  it('withoutButtonIcons drops the icon and keeps text, row, style and route', () => {
    const buttons: TelegramButton[] = [
      { text: 'a', data: 'x', row: 2, style: 'danger', iconCustomEmojiId: ICON },
      { text: 'b', url: 'https://e.example' },
    ];
    expect(buttonsHaveIcons(buttons)).toBe(true);
    const plain = withoutButtonIcons(buttons);
    expect(plain).toEqual([
      { text: 'a', data: 'x', row: 2, style: 'danger' },
      { text: 'b', url: 'https://e.example' },
    ]);
    expect(buttonsHaveIcons(plain)).toBe(false);
    expect(buttonsHaveIcons([{ text: 'a', data: 'x', iconCustomEmojiId: '' }])).toBe(false);
  });

  it('reads eligibility from the decoration: NO_DECORATION never, an eligible bot with no slot yes', () => {
    expect(mayCarryCustomEmoji(NO_DECORATION)).toBe(false);
    expect(mayCarryCustomEmoji({ customEmoji: new Map(), eligible: true })).toBe(true);
    expect(mayCarryCustomEmoji({ customEmoji: new Map([['wallet', ICON]]) })).toBe(true);
    expect(mayCarryCustomEmoji({ customEmoji: new Map() })).toBe(false);
  });
});

describe('inline-button icons as the messenger draws them', () => {
  it('draws the configured icon on its own button only, from an ELIGIBLE bot, and reads the setting once', async () => {
    const { messenger, calls, respondWith, iconReads } = harness({
      icons: { 'payment.sent': ICON, 'catalog.category': OTHER_ICON },
    });
    respondWith([OK]);
    expect(await send(messenger)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(1);
    expect(keyboardOf(calls[0]?.body)).toEqual([
      [
        {
          text: 'label:bot.payment.sent_button',
          callback_data: 'i:payment',
          icon_custom_emoji_id: ICON,
        },
        { text: 'label:bot.payment.copy_card_button', copy_text: { text: '6037991234567890' } },
      ],
      [{ text: 'label:bot.payment.gateway_pay_button', url: 'https://pay.example/x' }],
      [{ text: 'VPN', callback_data: 'c:1', icon_custom_emoji_id: OTHER_ICON }],
      [{ text: 'free', callback_data: 'free:1' }],
    ]);
    expect(iconReads()).toBe(1);
  });

  it('a second bot of the SAME tenant, never tested, draws the same keyboard with NO icon (and never reads them)', async () => {
    const { messenger, calls, respondWith, iconReads } = harness({
      icons: { 'payment.sent': ICON },
    });
    respondWith([OK]);
    await send(messenger, untestedBot);
    expect(iconsOf(calls[0]?.body).every((icon) => icon === null)).toBe(true);
    expect(iconReads()).toBe(0);
  });

  it('keeps every route, text and style byte for byte whether or not an icon is configured', async () => {
    const without = harness({ styles: { 'payment.sent': 'success' } });
    without.respondWith([OK]);
    await send(without.messenger);
    vi.unstubAllGlobals();
    const iconed = harness({
      styles: { 'payment.sent': 'success' },
      icons: {
        'payment.sent': ICON,
        'payment.copy_card': ICON,
        'payment.gateway_pay': ICON,
        'catalog.category': ICON,
      },
    });
    iconed.respondWith([OK]);
    await send(iconed.messenger);
    expect(iconsOf(iconed.calls[0]?.body)).toEqual([ICON, ICON, ICON, ICON, null]);
    expect(JSON.stringify(routesOf(iconed.calls[0]?.body))).toBe(
      JSON.stringify(routesOf(without.calls[0]?.body)),
    );
  });

  it('a REMOVED icon (or none, or no reader) falls back to the legacy markup byte for byte', async () => {
    const legacy = harness({ noIconReader: true });
    legacy.respondWith([OK]);
    await send(legacy.messenger);
    const before = JSON.stringify(legacy.calls[0]?.body);
    expect(before).not.toContain('icon_custom_emoji_id');
    for (const icons of [{}, { 'tickets.new': ICON }] as InlineButtonIcons[]) {
      vi.unstubAllGlobals();
      const removed = harness({ icons });
      removed.respondWith([OK]);
      await send(removed.messenger);
      expect(JSON.stringify(removed.calls[0]?.body)).toBe(before);
    }
  });

  it('a keyboard naming no registry button never reads the icons', async () => {
    const { messenger, respondWith, iconReads } = harness({ icons: { 'payment.sent': ICON } });
    respondWith([OK]);
    await send(messenger, eligibleBot, [{ label: { kind: 'TEXT', text: 'free' }, data: 'f' }]);
    expect(iconReads()).toBe(0);
  });
});

describe('the one icon-less retry (owner rule B5, extended to inline buttons)', () => {
  it('a custom-emoji DENIAL: ONE retry without icons, routes and text kept, the bot switched off', async () => {
    const { messenger, calls, events, refused, respondWith } = harness({
      icons: { 'payment.sent': ICON },
    });
    respondWith([DENIAL, OK]);
    expect(await send(messenger)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(iconsOf(calls[0]?.body)).toContain(ICON);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
    expect(routesOf(calls[1]?.body)).toEqual(routesOf(calls[0]?.body));
    expect(calls[1]?.body['text']).toBe(calls[0]?.body['text']);
    expect(refused).toEqual([eligibleBot]);
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_FAILED_CODE]);
    expect(events[0]?.context).toMatchObject({ keyboardIcons: true, eligibilityChanged: true });
  });

  it('a GENERIC 400: the same one retry lands, and the bot’s eligibility is NOT touched', async () => {
    const { messenger, calls, events, refused, respondWith } = harness({
      icons: { 'payment.sent': ICON },
    });
    respondWith([GENERIC, OK]);
    expect(await send(messenger)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
    expect(refused).toEqual([]);
    expect(events[0]?.context).toMatchObject({ keyboardIcons: true, eligibilityChanged: false });
  });

  it('a refusal the icon-less retry ALSO gets is the message’s answer: two calls, REFUSED', async () => {
    const { messenger, calls, refused, respondWith } = harness({ icons: { 'payment.sent': ICON } });
    respondWith([GENERIC, GENERIC]);
    expect(await send(messenger)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(2);
    expect(refused).toEqual([]);
  });

  it('never re-sends an iconed keyboard after a timeout, an unreadable 2xx, a 5xx or a 429', async () => {
    const cases = [
      ['TIMEOUT', 'UNKNOWN'],
      ['GARBLED', 'UNKNOWN'],
      [{ status: 502, body: { ok: false, description: 'Bad Gateway' } }, 'UNKNOWN'],
      [
        { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 3 } } },
        'RATE_LIMITED',
      ],
    ] as const;
    for (const [answer, outcome] of cases) {
      vi.unstubAllGlobals();
      const { messenger, calls, refused, respondWith } = harness({
        icons: { 'payment.sent': ICON },
      });
      respondWith([answer as Answer, OK]);
      expect((await send(messenger)).outcome, JSON.stringify(answer)).toBe(outcome);
      expect(calls, JSON.stringify(answer)).toHaveLength(1);
      expect(refused).toEqual([]);
    }
  });

  it('never retries an icon-less inline keyboard: a refusal is one call', async () => {
    const { messenger, calls, respondWith } = harness({ icons: {} });
    respondWith([GENERIC, OK]);
    expect(await send(messenger)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(1);
  });

  it('an EDIT in place carries the icon, and a denial retries it once without', async () => {
    const { messenger, calls, refused, respondWith } = harness({
      icons: { 'payment.sent': ICON },
    });
    respondWith([DENIAL, OK]);
    const sent = await messenger.edit(scope, {
      chatId: '42',
      messageId: 9,
      botInstanceId: eligibleBot,
      templateKey: 'bot.payment.receipt_prompt',
      values: { minutes: 5 },
      buttons: KEYBOARD,
    });
    expect(sent).toEqual({ outcome: 'DELIVERED' });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/editMessageText');
    expect(iconsOf(calls[0]?.body)).toContain(ICON);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
    expect(routesOf(calls[1]?.body)).toEqual(routesOf(calls[0]?.body));
    expect(refused).toEqual([eligibleBot]);
  });

  it('a caption EDIT carries the icon, and a denial retries it once without', async () => {
    const { messenger, calls, respondWith } = harness({ icons: { 'payment.sent': ICON } });
    respondWith([DENIAL, OK]);
    await messenger.editCaption(scope, {
      chatId: '42',
      messageId: 9,
      botInstanceId: eligibleBot,
      templateKey: 'bot.payment.receipt_prompt',
      values: { minutes: 5 },
      buttons: KEYBOARD,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/editMessageCaption');
    expect(iconsOf(calls[0]?.body)).toContain(ICON);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
  });

  it('a FILE sent by file_id carries the icon, and a denial retries it once without', async () => {
    const { messenger, calls, respondWith } = harness({ icons: { 'payment.sent': ICON } });
    respondWith([DENIAL, OK]);
    const sent = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId: eligibleBot,
      kind: 'PHOTO',
      source: { kind: 'FILE_ID', fileId: 'AgAC' },
      buttons: KEYBOARD,
    });
    expect(sent.outcome).toBe('DELIVERED');
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toContain('/sendPhoto');
    expect(iconsOf(calls[0]?.body)).toContain(ICON);
    expect(JSON.stringify(calls[1]?.body)).not.toContain('icon_custom_emoji_id');
  });

  it('a FILE without an icon is one call on a refusal, as before', async () => {
    const { messenger, calls, respondWith } = harness({ icons: {} });
    respondWith([GENERIC, OK]);
    const sent = await messenger.sendFile(scope, {
      chatId: '42',
      botInstanceId: eligibleBot,
      kind: 'PHOTO',
      source: { kind: 'FILE_ID', fileId: 'AgAC' },
      buttons: KEYBOARD,
    });
    expect(sent.outcome).toBe('REFUSED');
    expect(calls).toHaveLength(1);
  });
});
