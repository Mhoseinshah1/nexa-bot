import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_MENU_BUTTON,
  type AppearanceSlot,
  type BotInstanceId,
  type TenantContext,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import type { MainMenuKeyboardButton } from '../../apps/api/src/modules/commerce/messaging/application/main-menu';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  TelegramCustomerMessenger,
  isCustomEmojiDenial,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import {
  replyKeyboardButtonMarkup,
  textMessageBody,
} from '../../apps/api/src/infrastructure/telegram/send-message';

/**
 * Round T (T2) — the customer reply keyboard on the wire (`docs/round-t-button-builder-audit.md`
 * §12 T2, §13 R-1..R-6), and the one-shot fallback owner rule B5 binds.
 *
 * `fetch` is stubbed as `telegram-messenger-appearance.test.ts` stubs it: the thing under test
 * is what reaches the wire and how many times. A stub — like the HTTP fake — can only prove
 * this code agrees with itself; real-Telegram acceptance R-ACC-1..3 confirms the Bot API.
 */

const TEXT_KEY = 'bot.start.welcome' as const;
const ICON = '5368324170671202286';
const SUPPORT_ICON = '5368324170671202287';
const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const eligibleBot = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const untestedBot = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const OK = { status: 200, body: { ok: true, result: { message_id: 7 } } };
/** A refusal that names custom emoji: what `classifyProbeRefusal` reads as a denial. */
const DENIAL = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
};
/** A permanent 400 that names nothing about custom emoji. */
const GENERIC = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: BUTTON_TYPE_INVALID' },
};

/** An explicit published layout's rows, as `MainMenuLayout.keyboardFor` answers them. */
const EXPLICIT: MainMenuKeyboardButton[][] = [
  [
    { text: '👛 کیف پول', style: 'success', iconSlot: 'wallet' },
    { text: '🛒 خرید سرویس', style: 'primary', iconSlot: null },
    { text: '📦 سرویس‌های من', style: 'danger', iconSlot: null },
  ],
  [
    { text: '❓ راهنما', style: 'default', iconSlot: 'support' },
    { text: '🎫 پشتیبانی', style: 'default', iconSlot: 'payment' },
  ],
];
/** A never-published tenant's rows: what the legacy path of `keyboardFor` answers. */
const LEGACY: MainMenuKeyboardButton[][] = [
  [
    { text: '🛒 خرید سرویس', style: 'default', iconSlot: null },
    { text: '📦 سرویس‌های من', style: 'default', iconSlot: null },
  ],
  [{ text: '❓ راهنما', style: 'default', iconSlot: null }],
];

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A reader that decorates only `eligible` bots; `configuredDecoration` decorates every bot. */
function reader(
  eligible: readonly BotInstanceId[],
  slots: Partial<Record<AppearanceSlot, string>>,
) {
  const refused: BotInstanceId[] = [];
  const customEmoji = new Map(Object.entries(slots) as [AppearanceSlot, string][]);
  const appearance: AppearanceReader = {
    decorationFor: async (_scope, botInstanceId) => ({
      customEmoji: eligible.includes(botInstanceId) ? customEmoji : new Map(),
    }),
    configuredDecoration: async () => ({ customEmoji }),
    recordRuntimeRefusal: async (_scope, botInstanceId) => {
      refused.push(botInstanceId);
    },
  };
  return { appearance, refused };
}

function harness(
  rows: MainMenuKeyboardButton[][],
  options: {
    readonly appearance?: AppearanceReader;
    readonly text?: string;
  } = {},
) {
  const calls: Call[] = [];
  const events: { code: string; message?: string; context?: Record<string, unknown> }[] = [];
  const messenger = new TelegramCustomerMessenger(
    { render: async () => options.text ?? 'خوش آمدید' } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async (_scope: unknown, event: { code: string }) => events.push(event) } as never,
    { conditionIsOpen: async () => false } as never,
    'https://telegram.invalid',
    1000,
    { keyboardFor: async () => rows },
    options.appearance,
  );
  const respondWith = (answers: ({ status: number; body: unknown } | 'TIMEOUT' | 'GARBLED')[]) =>
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
  const send = (
    botInstanceId: BotInstanceId,
    keyboard: 'MAIN_MENU' | 'MAIN_MENU_ADMIN' = 'MAIN_MENU',
  ) =>
    messenger.send(scope, {
      chatId: '42',
      botInstanceId,
      templateKey: TEXT_KEY,
      values: {},
      keyboard,
    });
  return { messenger, calls, events, respondWith, send };
}

const keyboardOf = (call: Call | undefined) =>
  (call?.body['reply_markup'] as { keyboard: Record<string, unknown>[][] } | undefined)?.keyboard;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the reply-keyboard descriptor (send-message.ts)', () => {
  it('R-1 sends primary, success and danger verbatim and OMITS a default style', () => {
    expect(replyKeyboardButtonMarkup({ text: 'a', style: 'primary' })).toEqual({
      text: 'a',
      style: 'primary',
    });
    expect(replyKeyboardButtonMarkup({ text: 'a', style: 'success' })).toEqual({
      text: 'a',
      style: 'success',
    });
    expect(replyKeyboardButtonMarkup({ text: 'a', style: 'danger' })).toEqual({
      text: 'a',
      style: 'danger',
    });
    expect(replyKeyboardButtonMarkup({ text: 'a' })).toEqual({ text: 'a' });
    // A value outside Telegram's closed set never reaches the wire, whatever a caller passes.
    expect(replyKeyboardButtonMarkup({ text: 'a', style: 'default' as never })).toEqual({
      text: 'a',
    });
    expect(replyKeyboardButtonMarkup({ text: 'a', style: 'blue' as never })).toEqual({
      text: 'a',
    });
  });

  it('carries icon_custom_emoji_id beside an unaltered text, and never an empty one', () => {
    expect(
      replyKeyboardButtonMarkup({ text: '👛 کیف پول', style: 'success', iconCustomEmojiId: ICON }),
    ).toEqual({ text: '👛 کیف پول', style: 'success', icon_custom_emoji_id: ICON });
    expect(replyKeyboardButtonMarkup({ text: 'a', iconCustomEmojiId: '' })).toEqual({ text: 'a' });
  });

  it('draws a keyboard of strings, or of plain descriptors, byte for byte as before round T', () => {
    const before = JSON.stringify({
      chat_id: '42',
      text: 'x',
      link_preview_options: { is_disabled: true },
      reply_markup: {
        keyboard: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]],
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false,
        selective: false,
      },
    });
    expect(
      JSON.stringify(
        textMessageBody({ chatId: '42', text: 'x', html: false, keyboard: [['a', 'b'], ['c']] }),
      ),
    ).toBe(before);
    expect(
      JSON.stringify(
        textMessageBody({
          chatId: '42',
          text: 'x',
          html: false,
          keyboard: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]],
        }),
      ),
    ).toBe(before);
  });

  it('R-6 lets inline buttons win over the reply keyboard', () => {
    const body = textMessageBody({
      chatId: '42',
      text: 'x',
      html: false,
      buttons: [{ text: 'go', data: 'g' }],
      keyboard: [[{ text: 'a', style: 'primary', iconCustomEmojiId: ICON }]],
    });
    expect(body['reply_markup']).toEqual({
      inline_keyboard: [[{ text: 'go', callback_data: 'g' }]],
    });
  });
});

describe('the customer keyboard as the messenger draws it', () => {
  it('R-1/R-2 styles every button and icons only the slot this ELIGIBLE bot resolves', async () => {
    const { appearance } = reader([eligibleBot], { wallet: ICON, support: SUPPORT_ICON });
    const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([OK]);
    expect(await send(eligibleBot)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(1);
    expect(keyboardOf(calls[0])).toEqual([
      [
        { text: '👛 کیف پول', style: 'success', icon_custom_emoji_id: ICON },
        { text: '🛒 خرید سرویس', style: 'primary' },
        { text: '📦 سرویس‌های من', style: 'danger' },
      ],
      [
        // `default` omits the style; `support` is configured, so it carries its icon.
        { text: '❓ راهنما', icon_custom_emoji_id: SUPPORT_ICON },
        // `payment` has no custom emoji configured: no icon, never a guess.
        { text: '🎫 پشتیبانی' },
      ],
    ]);
  });

  it('R-2 gives a second bot of the SAME tenant, never tested, the same styles and NO icon', async () => {
    const { appearance } = reader([eligibleBot], { wallet: ICON, support: SUPPORT_ICON });
    const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([OK]);
    await send(eligibleBot);
    await send(untestedBot);
    expect(calls).toHaveLength(2);
    const icons = (call: Call | undefined) =>
      (keyboardOf(call) ?? []).flat().filter((button) => 'icon_custom_emoji_id' in button);
    expect(icons(calls[0])).toHaveLength(2);
    expect(icons(calls[1])).toEqual([]);
    expect(keyboardOf(calls[1])).toEqual([
      [
        { text: '👛 کیف پول', style: 'success' },
        { text: '🛒 خرید سرویس', style: 'primary' },
        { text: '📦 سرویس‌های من', style: 'danger' },
      ],
      [{ text: '❓ راهنما' }, { text: '🎫 پشتیبانی' }],
    ]);
  });

  it('R-3 never alters a label: the text is the rendered label whether or not it carries an icon', async () => {
    const { appearance } = reader([eligibleBot], { wallet: ICON, support: SUPPORT_ICON });
    const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([OK]);
    await send(eligibleBot);
    expect((keyboardOf(calls[0]) ?? []).map((row) => row.map((button) => button['text']))).toEqual(
      EXPLICIT.map((row) => row.map((button) => button.text)),
    );
  });

  it('keeps a never-published tenant’s keyboard byte for byte — no style, no icon — on an eligible bot', async () => {
    const { appearance } = reader([eligibleBot], { wallet: ICON, support: SUPPORT_ICON });
    const { calls, respondWith, send } = harness(LEGACY, { appearance });
    respondWith([OK]);
    await send(eligibleBot);
    expect(JSON.stringify(calls[0]?.body['reply_markup'])).toBe(
      JSON.stringify({
        keyboard: [
          [{ text: '🛒 خرید سرویس' }, { text: '📦 سرویس‌های من' }],
          [{ text: '❓ راهنما' }],
        ],
        resize_keyboard: true,
        is_persistent: true,
        one_time_keyboard: false,
        selective: false,
      }),
    );
  });

  it('R-6 appends the admin row unstyled and without an icon', async () => {
    const { appearance } = reader([eligibleBot], { wallet: ICON });
    const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([OK]);
    await send(eligibleBot, 'MAIN_MENU_ADMIN');
    expect(keyboardOf(calls[0])?.at(-1)).toEqual([{ text: CATALOGUE_FA[ADMIN_MENU_BUTTON.label] }]);
  });

  it('draws no icon without an appearance reader, as a bot with no proof draws none', async () => {
    const { calls, respondWith, send } = harness(EXPLICIT);
    respondWith([OK]);
    await send(eligibleBot);
    expect(JSON.stringify(keyboardOf(calls[0]))).not.toContain('icon_custom_emoji_id');
  });
});

describe('the one-shot fallback (owner rule B5)', () => {
  it('R-4 a custom-emoji denial: ONE retry without icons, text and styles kept, the bot switched off', async () => {
    const { appearance, refused } = reader([eligibleBot], { wallet: ICON, support: SUPPORT_ICON });
    const { calls, events, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([DENIAL, OK]);
    expect(await send(eligibleBot)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body['text']).toBe(calls[0]?.body['text']);
    expect(keyboardOf(calls[1])).toEqual([
      [
        { text: '👛 کیف پول', style: 'success' },
        { text: '🛒 خرید سرویس', style: 'primary' },
        { text: '📦 سرویس‌های من', style: 'danger' },
      ],
      [{ text: '❓ راهنما' }, { text: '🎫 پشتیبانی' }],
    ]);
    expect(refused).toEqual([eligibleBot]);
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_FAILED_CODE]);
    expect(events[0]?.context).toMatchObject({
      botInstanceId: eligibleBot,
      errorCode: 'telegram.rejected.400',
      keyboardIcons: true,
      eligibilityChanged: true,
    });
  });

  it('a GENERIC 400 on an iconed keyboard: the same one retry lands, and the bot’s eligibility is NOT touched', async () => {
    const { appearance, refused } = reader([eligibleBot], { wallet: ICON });
    const { calls, events, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([GENERIC, OK]);
    // What is sent: the iconed keyboard, then the same text and styles without icons.
    // The outcome: the customer has the message; the bot stays eligible; the operator is told.
    expect(await send(eligibleBot)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(keyboardOf(calls[0]))).toContain('icon_custom_emoji_id');
    expect(JSON.stringify(keyboardOf(calls[1]))).not.toContain('icon_custom_emoji_id');
    expect(keyboardOf(calls[1])?.[0]?.[0]).toEqual({ text: '👛 کیف پول', style: 'success' });
    expect(refused).toEqual([]);
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_FAILED_CODE]);
    expect(events[0]?.context).toMatchObject({ keyboardIcons: true, eligibilityChanged: false });
  });

  it('a generic 400 the icon-less retry ALSO gets is the message’s answer: two calls, REFUSED, no marking', async () => {
    const { appearance, refused } = reader([eligibleBot], { wallet: ICON });
    const { calls, events, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([GENERIC, GENERIC]);
    expect(await send(eligibleBot)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(2);
    expect(refused).toEqual([]);
    expect(events.map((event) => event.code)).not.toContain(APPEARANCE_DECORATION_FAILED_CODE);
  });

  it('R-5 never sends an iconed keyboard twice after a timeout, an unreadable 2xx, a 5xx or a 429', async () => {
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
      const { appearance, refused } = reader([eligibleBot], { wallet: ICON });
      const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
      respondWith([answer as never, OK]);
      expect((await send(eligibleBot)).outcome).toBe(outcome);
      expect(calls, JSON.stringify(answer)).toHaveLength(1);
      expect(refused).toEqual([]);
    }
  });

  it('makes at most ONE retry for one send: a decoration refused on part one strips the last part’s icons too', async () => {
    const { appearance, refused } = reader([eligibleBot], { wallet: ICON, payment: '77' });
    const line = `{icon:payment} ${'x'.repeat(3000)}`;
    const { calls, respondWith, send } = harness(EXPLICIT, {
      appearance,
      text: `${line}\n\n${line}`,
    });
    respondWith([DENIAL, OK, OK]);
    expect(await send(eligibleBot)).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    // Part one decorated and refused, part one plain, part two plain with no icon: three.
    expect(calls).toHaveLength(3);
    expect(keyboardOf(calls[0])).toBeUndefined();
    expect(JSON.stringify(keyboardOf(calls[2]))).not.toContain('icon_custom_emoji_id');
    expect(keyboardOf(calls[2])?.[0]?.[0]).toEqual({ text: '👛 کیف پول', style: 'success' });
    expect(refused).toEqual([eligibleBot]);
  });

  it('never retries an undecorated keyboard: a refusal of a plain, styled keyboard is one call', async () => {
    const { appearance, refused } = reader([], { wallet: ICON });
    const { calls, respondWith, send } = harness(EXPLICIT, { appearance });
    respondWith([GENERIC, OK]);
    expect(await send(untestedBot)).toEqual({ outcome: 'REFUSED' });
    expect(calls).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it('reads a denial with the probe’s classifier, not loosened', () => {
    expect(isCustomEmojiDenial('Bad Request: CUSTOM_EMOJI_INVALID')).toBe(true);
    expect(isCustomEmojiDenial('Bad Request: custom emoji are not available')).toBe(true);
    expect(isCustomEmojiDenial('Bad Request: BUTTON_TYPE_INVALID')).toBe(false);
    expect(isCustomEmojiDenial('Bad Request: chat not found')).toBe(false);
    expect(isCustomEmojiDenial('Bad Request: keyboard button is invalid (fake)')).toBe(false);
    expect(isCustomEmojiDenial('Forbidden: bot was blocked by the user')).toBe(false);
  });
});
