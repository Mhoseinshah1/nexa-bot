import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppearanceSlot, BotInstanceId, TenantContext } from '@nexa/contracts';
import { TELEGRAM_MESSAGE_MAX } from '../../apps/api/src/modules/commerce/messaging/application/message-split';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  APPEARANCE_DECORATION_OK_CODE,
  TelegramCustomerMessenger,
  classifyProbeRefusal,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';

/**
 * Premium UI in the messenger: one renderer for `sendMessage`, `editMessageText` and the
 * captions, eligibility never assumed, and a decoration Telegram refuses never costing the
 * customer their message (`docs/premium-ui-audit.md` §4, §6). `fetch` is stubbed as
 * `telegram-messenger-parts.test.ts` stubs it: the thing under test is what reaches the wire.
 */

const HTML_KEY = 'bot.admin.reminder_choose' as const;
const PLAIN_KEY = 'bot.admin.receipt' as const;
const ID = '5368324170671202286';
const scope = {
  tenantId: '01900000-0000-7000-8000-000000000001',
  botInstanceId: null,
} as TenantContext;
const botA = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
const botB = '01900000-0000-7000-8000-0000000000bb' as BotInstanceId;
const OK = { status: 200, body: { ok: true, result: { message_id: 7 } } };
const BAD = {
  status: 400,
  body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
};

interface Call {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

/** A reader that decorates only `eligible` bots, and records runtime refusals. */
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
  rendered: Partial<Record<string, string>>,
  appearance?: AppearanceReader,
  options: { conditionOpen?: boolean } = {},
) {
  const calls: Call[] = [];
  const events: { code: string; context?: Record<string, unknown> }[] = [];
  const messenger = new TelegramCustomerMessenger(
    { render: async (_scope: unknown, key: string) => rendered[key] ?? `label:${key}` } as never,
    { tokenForBotInstance: async () => 'test-token' } as never,
    { record: async (_scope: unknown, event: { code: string }) => events.push(event) } as never,
    { conditionIsOpen: async () => options.conditionOpen ?? false } as never,
    'https://telegram.invalid',
    1000,
    undefined,
    appearance,
  );
  const respondWith = (answers: { status: number; body: unknown }[]) =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        if (answer === undefined) throw new Error('no answer scripted');
        calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return { ok: answer.status < 400, status: answer.status, json: async () => answer.body };
      }),
    );
  return { messenger, calls, events, respondWith };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const BODY = 'پرداخت 🧪 {icon:payment} انجام شد {icon:success}';
const PAYMENT_ENTITY = { type: 'custom_emoji', offset: 10, length: 2, custom_emoji_id: ID };

describe('a bot that proved its eligibility', () => {
  it('sends the fallback emoji covered by a custom_emoji entity, and no parse_mode', async () => {
    const { appearance } = reader([botA], { payment: ID });
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance);
    respondWith([OK]);
    const result = await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(result).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls[0]?.body).toMatchObject({
      text: 'پرداخت 🧪 💳 انجام شد ✅',
      entities: [PAYMENT_ENTITY],
    });
    expect(calls[0]?.body).not.toHaveProperty('parse_mode');
  });

  it('carries the SAME text and entities through editMessageText as through sendMessage', async () => {
    const { appearance } = reader([botA], { payment: ID, success: '99' });
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance);
    respondWith([OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
    });
    await messenger.edit(scope, {
      chatId: '42',
      messageId: 7,
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url.endsWith('/editMessageText')).toBe(true);
    expect(calls[1]?.body['text']).toBe(calls[0]?.body['text']);
    expect(calls[1]?.body['entities']).toEqual(calls[0]?.body['entities']);
    expect(calls[0]?.body['entities']).toHaveLength(2);
  });

  it('writes tg-emoji tags into an HTML body, which Telegram parses, and sends no entities', async () => {
    const { appearance } = reader([botA], { payment: ID });
    const { messenger, calls, respondWith } = harness(
      { [HTML_KEY]: '<b>x</b> {icon:payment}' },
      appearance,
    );
    respondWith([OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: HTML_KEY,
      values: {},
    });
    expect(calls[0]?.body).toMatchObject({
      text: `<b>x</b> <tg-emoji emoji-id="${ID}">💳</tg-emoji>`,
      parse_mode: 'HTML',
    });
    expect(calls[0]?.body).not.toHaveProperty('entities');
  });

  it('keeps every entity on its own part when the body is split, never at a guessed offset', async () => {
    const line = `{icon:payment} ${'x'.repeat(1500)}`;
    const body = Array.from({ length: 5 }, () => line).join('\n\n');
    const { appearance } = reader([botA], { payment: ID });
    const { messenger, calls, respondWith } = harness({ [PLAIN_KEY]: body }, appearance);
    respondWith([OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(calls.length).toBeGreaterThan(1);
    let seen = 0;
    for (const call of calls) {
      const text = String(call.body['text']);
      expect(text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
      for (const entity of (call.body['entities'] ?? []) as { offset: number; length: number }[]) {
        expect(text.slice(entity.offset, entity.offset + entity.length)).toBe('💳');
        seen += 1;
      }
    }
    expect(seen).toBe(5);
  });
});

describe('fallback', () => {
  it('is what a bot with no proof gets — the emoji and nothing more — and what a stand-in without a reader gets', async () => {
    const { appearance } = reader([botA], { payment: ID });
    const withReader = harness({ [PLAIN_KEY]: BODY }, appearance);
    withReader.respondWith([OK]);
    await withReader.messenger.send(scope, {
      chatId: '42',
      botInstanceId: botB,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(withReader.calls[0]?.body).toEqual(
      expect.objectContaining({ text: 'پرداخت 🧪 💳 انجام شد ✅' }),
    );
    expect(withReader.calls[0]?.body).not.toHaveProperty('entities');

    vi.unstubAllGlobals();
    const without = harness({ [PLAIN_KEY]: BODY, [HTML_KEY]: '{icon:success} <i>x</i>' });
    without.respondWith([OK]);
    await without.messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
    });
    await without.messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: HTML_KEY,
      values: {},
    });
    expect(without.calls[0]?.body['text']).toBe('پرداخت 🧪 💳 انجام شد ✅');
    expect(without.calls[0]?.body).not.toHaveProperty('entities');
    expect(without.calls[1]?.body['text']).toBe('✅ <i>x</i>');
  });

  it('re-sends ONCE without decoration when Telegram refuses the decorated message, records the condition and switches the bot off', async () => {
    const { appearance, refused } = reader([botA], { payment: ID });
    const { messenger, calls, events, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance);
    respondWith([BAD, OK]);
    const result = await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
    });
    expect(result).toEqual({ outcome: 'DELIVERED', messageId: 7 });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body['entities']).toEqual([PAYMENT_ENTITY]);
    expect(calls[1]?.body['text']).toBe(calls[0]?.body['text']);
    expect(calls[1]?.body).not.toHaveProperty('entities');
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_FAILED_CODE]);
    expect(events[0]?.context).toMatchObject({
      botInstanceId: botA,
      errorCode: 'telegram.rejected.400',
    });
    expect(refused).toEqual([botA]);
  });

  it('does the same for an HTML body: the tag is undone, the text is otherwise untouched', async () => {
    const { appearance } = reader([botA], { payment: ID });
    const { messenger, calls, respondWith } = harness(
      { [HTML_KEY]: '<b>x</b> {icon:payment} &amp;' },
      appearance,
    );
    respondWith([BAD, OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: HTML_KEY,
      values: {},
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body).toMatchObject({ text: '<b>x</b> 💳 &amp;', parse_mode: 'HTML' });
  });

  it('never retries an UNKNOWN outcome, and never retries an undecorated refusal', async () => {
    const { appearance, refused } = reader([botA], { payment: ID });
    const { messenger, calls, events, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance);
    respondWith([{ status: 502, body: { ok: false, description: 'Bad Gateway' } }]);
    expect(
      await messenger.send(scope, {
        chatId: '42',
        botInstanceId: botA,
        templateKey: PLAIN_KEY,
        values: {},
      }),
    ).toEqual({
      outcome: 'UNKNOWN',
    });
    expect(calls).toHaveLength(1);
    expect(refused).toEqual([]);

    calls.length = 0;
    respondWith([BAD]);
    expect(
      await messenger.send(scope, {
        chatId: '42',
        botInstanceId: botB,
        templateKey: PLAIN_KEY,
        values: {},
      }),
    ).toEqual({
      outcome: 'REFUSED',
    });
    expect(calls).toHaveLength(1);
    expect(events.filter((event) => event.code === APPEARANCE_DECORATION_FAILED_CODE)).toHaveLength(
      0,
    );
  });

  it('reports the refusal, not the decoration, when the undecorated retry is refused too', async () => {
    const { appearance, refused } = reader([botA], { payment: ID });
    const { messenger, calls, events, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance);
    respondWith([
      BAD,
      { status: 400, body: { ok: false, error_code: 400, description: 'chat not found' } },
    ]);
    expect(
      await messenger.send(scope, {
        chatId: '42',
        botInstanceId: botA,
        templateKey: PLAIN_KEY,
        values: {},
      }),
    ).toEqual({
      outcome: 'REFUSED',
    });
    expect(calls).toHaveLength(2);
    expect(refused).toEqual([]);
    expect(events.map((event) => event.code)).not.toContain(APPEARANCE_DECORATION_FAILED_CODE);
  });

  it('draws a button label and a toast with the fallback, since neither can carry an entity', async () => {
    const { appearance } = reader([botA], { payment: ID });
    const { messenger, calls, respondWith } = harness(
      { [PLAIN_KEY]: 'body', [HTML_KEY]: '{icon:payment} pay' },
      appearance,
    );
    respondWith([OK]);
    await messenger.send(scope, {
      chatId: '42',
      botInstanceId: botA,
      templateKey: PLAIN_KEY,
      values: {},
      buttons: [{ label: { kind: 'TEMPLATE', key: HTML_KEY }, data: 'p:1' }],
    });
    expect(calls[0]?.body).toMatchObject({
      reply_markup: { inline_keyboard: [[{ text: '💳 pay', callback_data: 'p:1' }]] },
    });
  });
});

describe('the eligibility probe', () => {
  it('decorates every configured slot whatever the bot proved, and reads Telegram’s answer into the closed vocabulary', async () => {
    const { appearance } = reader([], { payment: ID, success: '2' });
    const { messenger, calls, events, respondWith } = harness({ [PLAIN_KEY]: BODY }, appearance, {
      conditionOpen: true,
    });
    respondWith([OK]);
    const sent = await messenger.sendAppearanceProbe(scope, {
      chatId: '42',
      botInstanceId: botB,
      templateKey: PLAIN_KEY,
    });
    expect(sent).toEqual({ outcome: 'SENT', errorCode: null, decoratedSlots: 2 });
    expect(calls[0]?.body['entities']).toHaveLength(2);
    // A `SENT` closes the bot's open decoration-failure condition.
    expect(events.map((event) => event.code)).toEqual([APPEARANCE_DECORATION_OK_CODE]);

    calls.length = 0;
    respondWith([BAD]);
    expect(
      await messenger.sendAppearanceProbe(scope, {
        chatId: '42',
        botInstanceId: botB,
        templateKey: PLAIN_KEY,
      }),
    ).toEqual({
      outcome: 'REJECTED',
      errorCode: 'appearance.custom_emoji_refused',
      decoratedSlots: 2,
    });
    // Refused once, never retried plain: the verdict is the point.
    expect(calls).toHaveLength(1);

    respondWith([{ status: 429, body: { ok: false, parameters: { retry_after: 3 } } }]);
    expect(
      (
        await messenger.sendAppearanceProbe(scope, {
          chatId: '42',
          botInstanceId: botB,
          templateKey: PLAIN_KEY,
        })
      ).outcome,
    ).toBe('RATE_LIMITED');
    respondWith([{ status: 502, body: { ok: false } }]);
    expect(
      (
        await messenger.sendAppearanceProbe(scope, {
          chatId: '42',
          botInstanceId: botB,
          templateKey: PLAIN_KEY,
        })
      ).errorCode,
    ).toBe('appearance.telegram_unreachable');
  });

  it('names a chat the operator never opened, and everything else, as their own codes', () => {
    expect(classifyProbeRefusal('Bad Request: chat not found')).toBe('appearance.chat_unavailable');
    expect(classifyProbeRefusal('Forbidden: bot was blocked by the user')).toBe(
      'appearance.chat_unavailable',
    );
    expect(classifyProbeRefusal("Bad Request: can't parse entities: ...")).toBe(
      'appearance.custom_emoji_refused',
    );
    expect(classifyProbeRefusal('Bad Request: message text is empty')).toBe(
      'appearance.telegram_rejected',
    );
  });
});
