import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  systemJobActor,
  type BotInstanceId,
  type CorrelationId,
  type TenantContext,
} from '@nexa/contracts';
import {
  TELEGRAM_RETRY_AFTER_MAX_MS,
  telegramRetryAfterMs,
  telegramSend,
  type TelegramSendOutcome,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import {
  APPEARANCE_DECORATION_FAILED_CODE,
  CUSTOMER_SEND_FAILED_CODE,
  TelegramCustomerMessenger,
} from '../../apps/api/src/modules/commerce/messaging/infrastructure/telegram-customer-messenger';
import type { AppearanceReader } from '../../apps/api/src/modules/commerce/messaging/application/ports';
import {
  classify as classifyBroadcast,
  classifyPin,
} from '../../apps/api/src/modules/commerce/broadcasts/infrastructure/telegram-broadcast.transport';
import { starsCreateOutcome } from '../../apps/api/src/modules/commerce/payments/infrastructure/telegram-stars-adapter';
import { BusinessTransport } from '../../apps/api/src/modules/commerce/business-chats/application/business-transport';
import { TelegramBusinessGateway } from '../../apps/api/src/modules/commerce/business-chats/infrastructure/telegram-business.gateway';
import { TelegramNotificationTransport } from '../../apps/api/src/modules/control/notifications/infrastructure/telegram-transport';

/**
 * Roadmap D1 (Telegram robustness): THREE outcomes, kept apart on every send path.
 *
 * - a DEFINITE refusal — Telegram read the request and said no; nothing was delivered;
 * - an explicit 429 — declined, nothing delivered, with a wait that is honoured only when it
 *   is DEFINITE;
 * - an UNKNOWN outcome — a timeout, a dropped connection, a 5xx, a 2xx this code cannot read —
 *   which may have been delivered and is therefore never sent again.
 *
 * `fetch` is stubbed: what is under test is the reading of an HTTP answer and what each lane
 * does with it. The real-socket version of the same is `tests/integration/telegram-multi-bot`.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

interface Answer {
  readonly status: number;
  /** A JSON value, or `THROW` for a body that will not parse. */
  readonly body: unknown;
}
const THROW = Symbol('unparseable');

function stubFetch(answers: readonly (Answer | 'NETWORK' | 'HANG')[]) {
  const seen: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: { body: string; signal: AbortSignal }) => {
      const answer = answers[Math.min(seen.length, answers.length - 1)];
      seen.push({ url, body: typeof init.body === 'string' ? JSON.parse(init.body) : null });
      if (answer === 'NETWORK') throw new TypeError('fetch failed');
      if (answer === 'HANG') {
        // A request that never answers: only the transport's own abort timer ends it.
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new Error('This operation was aborted')),
          );
        });
      }
      if (answer === undefined) throw new Error('no answer scripted');
      return {
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: async () => {
          if (answer.body === THROW) throw new SyntaxError('Unexpected end of JSON input');
          return answer.body;
        },
      };
    }),
  );
  return seen;
}

const request = { token: 't', apiBaseUrl: 'https://telegram.invalid', timeoutMs: 50, body: {} };

describe('the call core reads three outcomes', () => {
  it.each<[string, Answer | 'NETWORK' | 'HANG', Partial<TelegramSendOutcome>]>([
    [
      'a 200 ok:true',
      { status: 200, body: { ok: true, result: { message_id: 9 } } },
      { outcome: 'SUCCEEDED' },
    ],
    // Definite refusals.
    [
      'a 400',
      { status: 400, body: { ok: false, error_code: 400, description: 'Bad Request' } },
      { outcome: 'FAILED_PERMANENT', errorCode: 'telegram.rejected.400' },
    ],
    [
      'a 401',
      { status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } },
      { outcome: 'FAILED_PERMANENT', errorCode: 'telegram.rejected.401' },
    ],
    [
      'a 200 that SAYS ok:false',
      { status: 200, body: { ok: false, error_code: 400, description: 'no' } },
      { outcome: 'FAILED_PERMANENT' },
    ],
    // The explicit 429.
    [
      'a 429',
      { status: 429, body: { ok: false, parameters: { retry_after: 7 } } },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.rate_limited', retryAfterMs: 7000 },
    ],
    // Unknown outcomes.
    [
      'a 500',
      { status: 500, body: { ok: false } },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.server_error.500' },
    ],
    [
      'a 200 that will not parse',
      { status: 200, body: THROW },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreadable_response' },
    ],
    [
      'a 200 with no ok field',
      { status: 200, body: { description: 'proxy says hi' } },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreadable_response' },
    ],
    [
      'a 200 whose JSON is null',
      { status: 200, body: null },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreadable_response' },
    ],
    [
      'a 200 whose JSON is a bare value',
      { status: 200, body: 'ok' },
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreadable_response' },
    ],
    [
      'a network error',
      'NETWORK',
      { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreachable' },
    ],
    ['a timeout', 'HANG', { outcome: 'FAILED_RETRYABLE', errorCode: 'telegram.unreachable' }],
  ])('%s', async (_label, answer, expected) => {
    stubFetch([answer]);
    expect(await telegramSend(request)).toMatchObject(expected);
  });

  it('carries no wait on a 429 whose retry_after is not a definite number', async () => {
    for (const retryAfter of ['5', 'soon', null, -3, Number.NaN, { seconds: 5 }, true]) {
      stubFetch([{ status: 429, body: { ok: false, parameters: { retry_after: retryAfter } } }]);
      const outcome = await telegramSend(request);
      expect(outcome).toMatchObject({
        outcome: 'FAILED_RETRYABLE',
        errorCode: 'telegram.rate_limited',
      });
      expect(outcome).not.toHaveProperty('retryAfterMs');
    }
  });
});

describe('telegramRetryAfterMs — a wait only when it is definite', () => {
  it.each<[unknown, number | undefined]>([
    [0, 0],
    [1, 1000],
    [30, 30_000],
    // Rounded UP: never shorter than Telegram asked.
    [1.5, 1500],
    [0.0004, 1],
    // Held to the ceiling, so the lanes' integer columns and Date arithmetic stay valid.
    [10 ** 9, TELEGRAM_RETRY_AFTER_MAX_MS],
    [Number.POSITIVE_INFINITY, undefined],
    [-1, undefined],
    [Number.NaN, undefined],
    ['30', undefined],
    [null, undefined],
    [undefined, undefined],
  ])('%s → %s', (input, expected) => {
    expect(telegramRetryAfterMs(input)).toBe(expected);
  });

  it('a ceiling inside a 32-bit integer column', () => {
    expect(TELEGRAM_RETRY_AFTER_MAX_MS).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

/** The three canonical outcomes, as the call core produces them. */
const REFUSED: TelegramSendOutcome = {
  outcome: 'FAILED_PERMANENT',
  errorCode: 'telegram.rejected.400',
  errorMessage: 'Bad Request: message text is empty',
};
const LIMITED: TelegramSendOutcome = {
  outcome: 'FAILED_RETRYABLE',
  errorCode: 'telegram.rate_limited',
  errorMessage: 'Too Many Requests',
  retryAfterMs: 5000,
};
const UNKNOWNS: TelegramSendOutcome[] = [
  'telegram.unreachable',
  'telegram.unreadable_response',
  'telegram.server_error.502',
].map((errorCode) => ({ outcome: 'FAILED_RETRYABLE', errorCode, errorMessage: 'x' }));

describe('every lane keeps the three apart', () => {
  it('broadcast: REFUSED, RATE_LIMITED with the wait, UNKNOWN', () => {
    expect(classifyBroadcast(REFUSED)).toMatchObject({ outcome: 'REFUSED' });
    expect(classifyBroadcast(LIMITED)).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 5000 });
    for (const unknown of UNKNOWNS) {
      expect(classifyBroadcast(unknown)).toMatchObject({ outcome: 'UNKNOWN' });
    }
  });

  it('broadcast pin: a 429 is this attempt’s failure; an unknown pin is UNKNOWN', () => {
    expect(classifyPin(REFUSED)).toMatchObject({ outcome: 'FAILED' });
    expect(classifyPin(LIMITED)).toMatchObject({ outcome: 'FAILED' });
    for (const unknown of UNKNOWNS)
      expect(classifyPin(unknown)).toMatchObject({ outcome: 'UNKNOWN' });
  });

  it('Stars invoice: REFUSED, RATE_LIMITED, UNKNOWN — an unknown create is never re-sent', () => {
    expect(starsCreateOutcome(REFUSED, 'o', 10n, '1')).toMatchObject({ kind: 'REFUSED' });
    expect(starsCreateOutcome(LIMITED, 'o', 10n, '1')).toMatchObject({ kind: 'RATE_LIMITED' });
    for (const unknown of UNKNOWNS) {
      expect(starsCreateOutcome(unknown, 'o', 10n, '1')).toMatchObject({ kind: 'UNKNOWN' });
    }
  });

  it('ops notifications: a 429 is flagged as rate, a timeout is not', async () => {
    const transport = new TelegramNotificationTransport(
      { activeTokenForTenant: async () => 't', tokenForBotInstance: async () => 't' },
      'https://telegram.invalid',
      50,
    );
    const message = {
      destination: { transport: 'TELEGRAM' as const, chatId: '-1', topicId: null },
      text: 'x',
      html: false,
      tenantId: '01900000-0000-7000-8000-000000000001',
    };
    stubFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 'garbage' } } }]);
    const limited = await transport.send(message);
    expect(limited).toMatchObject({ rateLimited: true });
    expect(limited).not.toHaveProperty('retryAfterMs');
    stubFetch(['HANG']);
    expect(await transport.send(message)).not.toHaveProperty('rateLimited');
  });

  it('business: the CONNECTION’s bot sends, and a 2xx it cannot read is UNKNOWN', async () => {
    const tokens: string[] = [];
    const connection = (botInstanceId: string) => ({
      id: 'row-1',
      tenantId: 'tenant-a',
      botInstanceId,
      connectionId: 'conn-1',
      ownerTelegramUserId: '5',
      ownerUserChatId: '5',
      isEnabled: true,
      rights: ['can_reply'],
      connectedAt: new Date(0),
      lastConfirmedAt: new Date(0),
      supersededAt: null,
      version: 1,
    });
    let current = connection('bot-1');
    const transport = new BusinessTransport({
      repository: { findById: async () => current } as never,
      connections: { verify: async () => 'ACTIVE' } as never,
      telegram: new TelegramBusinessGateway({
        apiBaseUrl: 'https://telegram.invalid',
        timeoutMs: 50,
      } as never),
      tokens: {
        tokenForBotInstance: async (_scope: unknown, id: string) => {
          tokens.push(id);
          return `token-of-${id}`;
        },
      } as never,
      opsLog: { record: async () => ({ isNew: true, reopened: false }) } as never,
      clock: { now: () => new Date(0) },
    });
    const send = () =>
      transport.sendText(
        { tenantId: 'tenant-a', botInstanceId: null } as never,
        systemJobActor('t', 'c' as CorrelationId),
        { connectionRowId: 'row-1', chatId: '7', text: 'سلام' },
      );

    const seen = stubFetch([{ status: 200, body: { result: {} } }]);
    expect(await send()).toEqual({ outcome: 'UNKNOWN', errorCode: 'telegram.unreadable_response' });
    expect(seen[0]?.url).toContain('/bottoken-of-bot-1/');

    // The owner reconnected the account through ANOTHER bot of the tenant.
    current = connection('bot-2');
    const again = stubFetch([
      { status: 200, body: { ok: true, result: { message_id: 3, date: 1 } } },
    ]);
    expect(await send()).toMatchObject({ outcome: 'DELIVERED' });
    expect(again[0]?.url).toContain('/bottoken-of-bot-2/');
    expect(tokens).toEqual(['bot-1', 'bot-2']);
  });
});

describe('the customer messenger never sends one message twice', () => {
  const scope = {
    tenantId: '01900000-0000-7000-8000-000000000001',
    botInstanceId: null,
  } as TenantContext;
  const BOT = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
  const PLAIN_KEY = 'bot.admin.receipt' as const;

  function messenger(decorated: boolean) {
    const events: { code: string; dedupeKey?: string; context?: Record<string, unknown> }[] = [];
    const appearance: AppearanceReader = {
      decorationFor: async () => ({
        customEmoji: decorated ? new Map([['payment', '5368324170671202286']]) : new Map(),
      }),
      configuredDecoration: async () => ({ customEmoji: new Map() }),
      recordRuntimeRefusal: async () => undefined,
    } as never;
    const instance = new TelegramCustomerMessenger(
      { render: async () => 'پرداخت {icon:payment} انجام شد' } as never,
      { tokenForBotInstance: async () => 'test-token' } as never,
      { record: async (_scope: unknown, event: { code: string }) => events.push(event) } as never,
      { conditionIsOpen: async () => false } as never,
      'https://telegram.invalid',
      50,
      undefined,
      appearance,
    );
    const send = () =>
      instance.send(scope, {
        chatId: '42',
        botInstanceId: BOT,
        templateKey: PLAIN_KEY,
        values: {},
      });
    return { send, events };
  }

  it.each<[string, Answer | 'NETWORK' | 'HANG', string]>([
    ['a 2xx without ok (may have landed)', { status: 200, body: { description: 'x' } }, 'UNKNOWN'],
    ['a 2xx that will not parse', { status: 200, body: THROW }, 'UNKNOWN'],
    ['a timeout', 'HANG', 'UNKNOWN'],
    ['a dropped connection', 'NETWORK', 'UNKNOWN'],
    ['a 503', { status: 503, body: { ok: false } }, 'UNKNOWN'],
    ['a 429', { status: 429, body: { ok: false, parameters: { retry_after: 3 } } }, 'RATE_LIMITED'],
  ])(
    'a DECORATED message answered by %s is not retried, not even without its icons',
    async (_label, answer, outcome) => {
      const { send, events } = messenger(true);
      const seen = stubFetch([
        answer,
        { status: 200, body: { ok: true, result: { message_id: 1 } } },
      ]);
      expect((await send()).outcome).toBe(outcome);
      expect(seen).toHaveLength(1);
      expect(events.map((event) => event.code)).not.toContain(APPEARANCE_DECORATION_FAILED_CODE);
    },
  );

  it('a 429 hands the caller Telegram’s wait, and an undefinable one none', async () => {
    const { send } = messenger(false);
    stubFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 3 } } }]);
    expect(await send()).toEqual({ outcome: 'RATE_LIMITED', retryAfterMs: 3000 });
    stubFetch([{ status: 429, body: { ok: false, parameters: { retry_after: 'x' } } }]);
    expect(await send()).toEqual({ outcome: 'RATE_LIMITED' });
  });

  it('only a DEFINITE refusal of a decorated message earns the one plain retry', async () => {
    const { send, events } = messenger(true);
    const seen = stubFetch([
      {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
      },
      { status: 200, body: { ok: true, result: { message_id: 1 } } },
    ]);
    expect((await send()).outcome).toBe('DELIVERED');
    expect(seen).toHaveLength(2);
    expect(events.map((event) => event.code)).toContain(APPEARANCE_DECORATION_FAILED_CODE);
  });

  it('a revoked token is recorded as TOKEN_REJECTED, any other refusal as REFUSED', async () => {
    const revoked = messenger(false);
    stubFetch([{ status: 401, body: { ok: false, error_code: 401, description: 'Unauthorized' } }]);
    expect(await revoked.send()).toEqual({ outcome: 'REFUSED' });
    expect(revoked.events).toEqual([
      expect.objectContaining({
        code: CUSTOMER_SEND_FAILED_CODE,
        // Review B1: its own row, so the row's sentence is always the token's.
        dedupeKey: `telegram.customer_send_failed:${BOT}:token`,
        context: expect.objectContaining({
          reason: 'TOKEN_REJECTED',
          errorCode: 'telegram.rejected.401',
        }),
      }),
    ]);

    // Review N6: a 404 is a token path Telegram does not recognise — the same remedy.
    const malformed = messenger(false);
    stubFetch([{ status: 404, body: { ok: false, error_code: 404, description: 'Not Found' } }]);
    expect(await malformed.send()).toEqual({ outcome: 'REFUSED' });
    expect(malformed.events[0]?.context).toMatchObject({ reason: 'TOKEN_REJECTED' });

    const refused = messenger(false);
    stubFetch([
      {
        status: 403,
        body: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' },
      },
    ]);
    expect(await refused.send()).toEqual({ outcome: 'REFUSED' });
    expect(refused.events[0]).toMatchObject({
      dedupeKey: `telegram.customer_send_failed:${BOT}`,
      context: { reason: 'REFUSED' },
    });
  });
});

/**
 * Roadmap D4: icon eligibility, and the bookkeeping around a decorated send, never decide
 * whether a customer's message goes — and never turn a DELIVERED message into an exception
 * a caller could read as "not sent" and repeat.
 */
describe('premium decoration never breaks a send', () => {
  const scope = {
    tenantId: '01900000-0000-7000-8000-000000000001',
    botInstanceId: null,
  } as TenantContext;
  const BOT = '01900000-0000-7000-8000-0000000000aa' as BotInstanceId;
  const ID = '5368324170671202286';
  const OK = { status: 200, body: { ok: true, result: { message_id: 1 } } };

  function build(options: {
    decorationThrows?: boolean;
    opsLogThrows?: boolean;
    conditionThrows?: boolean;
    iconsThrow?: boolean;
    stylesThrow?: boolean;
  }) {
    const warnings: string[] = [];
    const refusals: string[] = [];
    const instance = new TelegramCustomerMessenger(
      { render: async () => 'پرداخت {icon:payment} انجام شد' } as never,
      { tokenForBotInstance: async () => 'test-token' } as never,
      {
        record: async () => {
          if (options.opsLogThrows) throw new Error('ops log down');
          return { isNew: true, reopened: false };
        },
      } as never,
      {
        conditionIsOpen: async () => {
          if (options.conditionThrows) throw new Error('db down');
          return false;
        },
      } as never,
      'https://telegram.invalid',
      50,
      undefined,
      {
        decorationFor: async () => {
          if (options.decorationThrows) throw new Error('appearance store down');
          return { customEmoji: new Map([['payment', ID]]) };
        },
        configuredDecoration: async () => ({ customEmoji: new Map() }),
        recordRuntimeRefusal: async (_scope: unknown, bot: string) => {
          refusals.push(bot);
        },
      } as never,
      {
        stylesFor: async () => {
          if (options.stylesThrow) throw new Error('setting unreadable');
          return {};
        },
        iconsFor: async () => {
          if (options.iconsThrow) throw new Error('setting unreadable');
          return { 'services.page': ID };
        },
      } as never,
      { warn: (_context: Record<string, unknown>, message: string) => warnings.push(message) },
    );
    return { instance, warnings, refusals };
  }
  const message = {
    chatId: '42',
    botInstanceId: BOT,
    templateKey: 'bot.admin.receipt' as const,
    values: {},
  };

  it('an eligibility read that fails sends the message undecorated, once', async () => {
    const { instance, warnings } = build({ decorationThrows: true });
    const seen = stubFetch([OK]);
    expect((await instance.send(scope, message)).outcome).toBe('DELIVERED');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).not.toHaveProperty('entities');
    expect(warnings.join(' ')).toContain('decoration');
  });

  it('an icon setting that cannot be read draws the plain label; the route is untouched', async () => {
    const { instance } = build({ iconsThrow: true });
    const seen = stubFetch([OK]);
    const sent = await instance.send(scope, {
      ...message,
      buttons: [
        { label: { kind: 'TEXT', text: 'خرید' }, data: 'buy:1', inline: 'services.page' },
      ] as never,
    });
    expect(sent.outcome).toBe('DELIVERED');
    const markup = (
      seen[0]?.body as { reply_markup: { inline_keyboard: Record<string, unknown>[][] } }
    ).reply_markup.inline_keyboard;
    expect(markup[0]?.[0]).toMatchObject({ text: 'خرید', callback_data: 'buy:1' });
    expect(markup[0]?.[0]).not.toHaveProperty('icon_custom_emoji_id');
  });

  it('a refused decoration delivered plain stays DELIVERED when recording the refusal fails', async () => {
    const { instance, warnings } = build({ opsLogThrows: true });
    const seen = stubFetch([
      {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
      },
      OK,
    ]);
    expect((await instance.send(scope, message)).outcome).toBe('DELIVERED');
    expect(seen).toHaveLength(2);
    expect(warnings.join(' ')).toContain('refused decoration');
  });

  it('review N3: the eligibility write still runs when the ops log cannot be written', async () => {
    const { instance, refusals } = build({ opsLogThrows: true });
    stubFetch([
      {
        status: 400,
        body: { ok: false, error_code: 400, description: 'Bad Request: CUSTOM_EMOJI_INVALID' },
      },
      OK,
    ]);
    expect((await instance.send(scope, message)).outcome).toBe('DELIVERED');
    // Text decoration refused and the plain copy accepted: this bot is switched off.
    expect(refusals).toEqual([BOT]);
  });

  it('Codex P2: a style or colour setting that cannot be read still sends the keyboard', async () => {
    const { instance } = build({ stylesThrow: true });
    const seen = stubFetch([OK]);
    const sent = await instance.send(scope, {
      ...message,
      buttons: [
        { label: { kind: 'TEXT', text: 'خرید' }, data: 'buy:1', inline: 'services.page' },
      ] as never,
    });
    expect(sent.outcome).toBe('DELIVERED');
    const cell = (
      seen[0]?.body as { reply_markup: { inline_keyboard: Record<string, unknown>[][] } }
    ).reply_markup.inline_keyboard[0]?.[0];
    expect(cell).toMatchObject({ text: 'خرید', callback_data: 'buy:1' });
    expect(cell).not.toHaveProperty('style');
  });

  it('Codex P1: an UNKNOWN outcome reaches the caller even when its condition cannot be recorded', async () => {
    const { instance, warnings } = build({ opsLogThrows: true });
    const seen = stubFetch([{ status: 200, body: { description: 'not a Bot API answer' } }]);
    expect(await instance.send(scope, message)).toEqual({ outcome: 'UNKNOWN' });
    expect(seen).toHaveLength(1);
    expect(warnings.join(' ')).toContain('send-failure condition');
    // ...and a refusal, and a missing bot, the same way.
    stubFetch([{ status: 403, body: { ok: false, error_code: 403, description: 'Forbidden' } }]);
    expect(await instance.send(scope, message)).toEqual({ outcome: 'REFUSED' });
  });

  it('a delivered message stays DELIVERED when the recovery bookkeeping fails', async () => {
    const { instance } = build({ conditionThrows: true });
    stubFetch([OK]);
    expect((await instance.send(scope, message)).outcome).toBe('DELIVERED');
  });
});
