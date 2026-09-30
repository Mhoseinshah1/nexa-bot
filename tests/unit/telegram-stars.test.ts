import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BOT_COMMANDS,
  money,
  PAYMENT_GATEWAY_DESCRIPTORS,
  TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS,
  telegramStarsFor,
  templateDefinition,
  validateTemplateBody,
} from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  telegramAnswerPreCheckoutQuery,
  telegramSendInvoice,
} from '../../apps/api/src/infrastructure/telegram/send-message';
import {
  starsCreateOutcome,
  TelegramStarsAdapter,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/telegram-stars-adapter';
import {
  starsIdentityMismatch,
  starsPreCheckoutRefusal,
  type StarsCheckFacts,
} from '../../apps/api/src/modules/commerce/payments/domain/telegram-stars';
import {
  hasSuccessfulPayment,
  starsAmountOf,
  starsPreCheckoutOf,
  starsSuccessfulPaymentOf,
} from '../../apps/api/src/surfaces/telegram/stars-updates';
import {
  GATEWAY_ROUTE_PAY_CALLBACK_PREFIX,
  intentOf,
} from '../../apps/api/src/surfaces/telegram/bot-runtime';

/**
 * Package A — Telegram Stars, the pure rules (`docs/package-a-telegram-stars-audit.md`).
 * The end-to-end cases are `tests/integration/telegram-stars.test.ts`.
 */

describe('the conversion (A1)', () => {
  it('is ceil(payable / rate) in bigint, and a positive payable is at least one Star', () => {
    expect(telegramStarsFor(105_000n, 1_300n)).toBe(81n); // 80.77 → 81
    expect(telegramStarsFor(260_000n, 1_300n)).toBe(200n); // exact
    expect(telegramStarsFor(260_001n, 1_300n)).toBe(201n); // one Toman over → one Star more
    expect(telegramStarsFor(1n, 1_300n)).toBe(1n);
    expect(telegramStarsFor(1_300n, 1n)).toBe(1_300n);
    // Far past 2^53, where a float would round.
    expect(telegramStarsFor(9_007_199_254_740_993n, 1n)).toBe(9_007_199_254_740_993n);
    expect(telegramStarsFor(9_007_199_254_740_993n, 2n)).toBe(4_503_599_627_370_497n);
  });

  it('has no amount for a non-positive payable or rate', () => {
    expect(telegramStarsFor(0n, 1_300n)).toBeNull();
    expect(telegramStarsFor(-5n, 1_300n)).toBeNull();
    expect(telegramStarsFor(100n, 0n)).toBeNull();
  });

  it('the adapter converts only with a rate', () => {
    const adapter = new TelegramStarsAdapter({ apiBaseUrl: 'https://t.invalid', timeoutMs: 10 });
    const payable = money(105_000n, 'IRT');
    expect(adapter.providerAmountOf(payable, { policy: 'FIXED_RATE', rateMinor: 1_300n })).toBe(
      81n,
    );
    // A Star is never billed in the sales currency (package FX): no rate, no amount.
    expect(adapter.providerAmountOf(payable, { policy: 'SAME_UNIT' })).toBeNull();
  });

  it('the descriptor says how Stars are sent, approved and priced', () => {
    expect(PAYMENT_GATEWAY_DESCRIPTORS.TELEGRAM_STARS).toEqual({
      provider: 'TELEGRAM_STARS',
      settlesVia: 'GATEWAY',
      requiresCredentials: false,
      invoiceCredential: 'BOT_TOKEN',
      approval: 'RECORDED_PAYMENT',
      // Package FX: the fixed rate stays first and default; the central rate is opt-in.
      conversion: {
        policies: ['FIXED_RATE', 'CENTRAL_FX'],
        fxBaseAsset: 'USDT',
        modeSetting: 'stars.pricing_mode',
        unitRatioSetting: 'stars.per_usdt',
      },
    });
    expect(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS.approval).toBe('INQUIRY');
  });
});

describe('the invoice payload (A2)', () => {
  it('is 32 lower-case hex characters of randomness, and never repeats', () => {
    const adapter = new TelegramStarsAdapter({ apiBaseUrl: 'https://t.invalid', timeoutMs: 10 });
    const ids = new Set(Array.from({ length: 50 }, () => adapter.newOrderId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{32}$/u);
  });
});

describe('the sendInvoice and answerPreCheckoutQuery bodies (A2, A3)', () => {
  const seen: { url: string; body: Record<string, unknown> }[] = [];
  const respond = (status: number, body: unknown) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body: string }) => {
        seen.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
        return { ok: status < 400, status, json: async () => body };
      }),
    );
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    seen.length = 0;
  });

  it('sends XTR, one price, an empty provider token, and nothing a customer could adjust', async () => {
    respond(200, { ok: true, result: { message_id: 42 } });
    const outcome = await telegramSendInvoice({
      token: 'T0KEN',
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 1000,
      chatId: '910910',
      title: 'title',
      description: 'description',
      payload: 'a'.repeat(32),
      priceLabel: 'label',
      stars: 81n,
    });
    expect(outcome).toEqual({ outcome: 'SUCCEEDED', messageId: 42 });
    expect(seen[0]!.url).toBe('https://t.invalid/botT0KEN/sendInvoice');
    expect(seen[0]!.body).toEqual({
      chat_id: '910910',
      title: 'title',
      description: 'description',
      payload: 'a'.repeat(32),
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: 'label', amount: 81 }],
    });
  });

  it('refuses a Star amount it cannot carry, before any call', async () => {
    respond(200, { ok: true, result: { message_id: 1 } });
    const base = {
      token: 't',
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      chatId: '1',
      title: 't',
      description: 'd',
      payload: 'p',
      priceLabel: 'l',
    };
    expect((await telegramSendInvoice({ ...base, stars: 0n })).outcome).toBe('FAILED_PERMANENT');
    expect((await telegramSendInvoice({ ...base, stars: 2n ** 60n })).outcome).toBe(
      'FAILED_PERMANENT',
    );
    expect(seen).toHaveLength(0);
  });

  it('answers a refusal with the sentence, and an approval without one', async () => {
    respond(200, { ok: true, result: true });
    await telegramAnswerPreCheckoutQuery({
      token: 't',
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      preCheckoutQueryId: 'q1',
      ok: false,
      errorMessage: 'no',
    });
    await telegramAnswerPreCheckoutQuery({
      token: 't',
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      preCheckoutQueryId: 'q2',
      ok: true,
      errorMessage: 'ignored',
    });
    expect(seen.map((call) => call.body)).toEqual([
      { pre_checkout_query_id: 'q1', ok: false, error_message: 'no' },
      { pre_checkout_query_id: 'q2', ok: true },
    ]);
  });
});

describe('what a sendInvoice answer means for the attempt (A2)', () => {
  const failed = (outcome: 'FAILED_RETRYABLE' | 'FAILED_PERMANENT', errorCode: string) =>
    starsCreateOutcome({ outcome, errorCode, errorMessage: 'x' }, 'order', 81n, '910910');

  it('is CREATED with the chat and the message id', () => {
    expect(
      starsCreateOutcome({ outcome: 'SUCCEEDED', messageId: 42 }, 'order', 81n, '910910'),
    ).toEqual({
      kind: 'CREATED',
      invoiceId: 'message:910910:42',
      orderId: 'order',
      invoiceUrl: null,
      webInvoiceUrl: null,
      status: null,
      requestAmount: 81n,
      finalAmount: null,
    });
  });

  it('keeps a rate limit, a refusal and an unknown answer apart', () => {
    expect(failed('FAILED_RETRYABLE', 'telegram.rate_limited').kind).toBe('RATE_LIMITED');
    // A timeout, a 5xx and an unreadable 2xx may each have delivered the invoice.
    for (const code of [
      'telegram.unreachable',
      'telegram.server_error.502',
      'telegram.unreadable_response',
    ]) {
      expect(failed('FAILED_RETRYABLE', code).kind).toBe('UNKNOWN');
    }
    expect(starsCreateOutcome({ outcome: 'SUCCEEDED', messageId: null }, 'o', 1n, '1').kind).toBe(
      'UNKNOWN',
    );
    expect(failed('FAILED_PERMANENT', 'telegram.rejected.400')).toMatchObject({
      kind: 'REFUSED',
      configuration: false,
    });
    expect(failed('FAILED_PERMANENT', 'telegram.rejected.403')).toMatchObject({
      kind: 'REFUSED',
      configuration: false,
    });
    expect(failed('FAILED_PERMANENT', 'telegram.rejected.401')).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
    expect(failed('FAILED_PERMANENT', 'telegram.rejected.404')).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
  });

  it('refuses before any call when the chat or the invoice text is missing', async () => {
    const send = vi.fn();
    const adapter = new TelegramStarsAdapter({
      apiBaseUrl: 'https://t.invalid',
      timeoutMs: 10,
      send,
    });
    const request = { orderId: 'o', amount: 5n, callbackUrl: null };
    expect(
      await adapter.createInvoice('t', {
        ...request,
        buyerChatId: null,
        presentation: { title: 't', description: 'd', priceLabel: 'l' },
      }),
    ).toMatchObject({ kind: 'REFUSED', code: 'nexa.chat_unknown' });
    expect(
      await adapter.createInvoice('t', { ...request, buyerChatId: '1', presentation: null }),
    ).toMatchObject({ kind: 'REFUSED', configuration: true });
    expect(send).not.toHaveBeenCalled();
    // And it never inquires: approval is a recorded payment.
    expect(await adapter.inquire()).toEqual({ kind: 'FAILED', code: 'nexa.not_inquirable' });
    expect(adapter.parseWebhook()).toBeNull();
  });
});

describe('pre-checkout and successful_payment checks (A3, A4)', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');
  const facts = (overrides: Partial<StarsCheckFacts> = {}): StarsCheckFacts => ({
    invoice: { botInstanceId: 'bot-a', sentAmount: 81n, providerUnit: 'XTR' },
    payment: { state: 'PENDING', expiresAt: new Date(now.getTime() + 30 * 60_000), orderId: null },
    customer: { telegramUserId: '910910', status: 'ACTIVE' },
    orderState: null,
    botInstanceId: 'bot-a',
    update: { payerTelegramUserId: '910910', currency: 'XTR', totalAmount: 81n },
    now,
    ...overrides,
  });

  it('approves the attempt’s own payer, bot, currency and Stars', () => {
    expect(starsPreCheckoutRefusal(facts())).toBeNull();
    expect(starsIdentityMismatch(facts())).toBeNull();
  });

  it('names each identity mismatch', () => {
    expect(starsIdentityMismatch(facts({ botInstanceId: 'bot-b' }))).toBe('WRONG_BOT');
    expect(
      starsIdentityMismatch(
        facts({ invoice: { botInstanceId: null, sentAmount: 81n, providerUnit: 'XTR' } }),
      ),
    ).toBe('WRONG_BOT');
    expect(
      starsIdentityMismatch(
        facts({ update: { payerTelegramUserId: '1', currency: 'XTR', totalAmount: 81n } }),
      ),
    ).toBe('WRONG_PAYER');
    expect(starsIdentityMismatch(facts({ customer: null }))).toBe('WRONG_PAYER');
    expect(
      starsIdentityMismatch(
        facts({ update: { payerTelegramUserId: '910910', currency: 'USD', totalAmount: 81n } }),
      ),
    ).toBe('WRONG_CURRENCY');
    expect(
      starsIdentityMismatch(
        facts({ update: { payerTelegramUserId: '910910', currency: 'XTR', totalAmount: 80n } }),
      ),
    ).toBe('WRONG_AMOUNT');
    expect(
      starsIdentityMismatch(
        facts({ update: { payerTelegramUserId: '910910', currency: 'XTR', totalAmount: 82n } }),
      ),
    ).toBe('WRONG_AMOUNT');
  });

  it('refuses a blocked customer, a closed attempt, a closed order, and the last two minutes', () => {
    expect(
      starsPreCheckoutRefusal(facts({ customer: { telegramUserId: '910910', status: 'BLOCKED' } })),
    ).toBe('CUSTOMER_BLOCKED');
    expect(
      starsPreCheckoutRefusal(
        facts({ payment: { state: 'EXPIRED', expiresAt: null, orderId: null } }),
      ),
    ).toBe('NOT_PENDING');
    expect(
      starsPreCheckoutRefusal(
        facts({
          payment: { state: 'PENDING', expiresAt: new Date(now.getTime() + 1000), orderId: 'o' },
        }),
      ),
    ).toBe('TOO_LATE');
    const onTheMargin = new Date(now.getTime() + TELEGRAM_STARS_PRE_CHECKOUT_MARGIN_MS);
    expect(
      starsPreCheckoutRefusal(
        facts({ payment: { state: 'PENDING', expiresAt: onTheMargin, orderId: null } }),
      ),
    ).toBeNull();
    expect(
      starsPreCheckoutRefusal(
        facts({
          payment: {
            state: 'PENDING',
            expiresAt: new Date(onTheMargin.getTime() - 1),
            orderId: null,
          },
        }),
      ),
    ).toBe('TOO_LATE');
    const order = { state: 'PENDING', expiresAt: onTheMargin, orderId: 'o' };
    expect(starsPreCheckoutRefusal(facts({ payment: order, orderState: 'CANCELLED' }))).toBe(
      'ORDER_CLOSED',
    );
    expect(
      starsPreCheckoutRefusal(facts({ payment: order, orderState: 'AWAITING_PAYMENT' })),
    ).toBeNull();
  });
});

describe('reading the two payment updates at the boundary', () => {
  it('reads a pre-checkout query, and answers even a malformed amount or payload', () => {
    const update = {
      pre_checkout_query: {
        id: 'q',
        from: { id: 910910, is_bot: false },
        currency: 'XTR',
        total_amount: 81,
        invoice_payload: 'abc',
      },
    };
    expect(starsPreCheckoutOf(update)).toEqual({
      queryId: 'q',
      payerTelegramUserId: '910910',
      currency: 'XTR',
      totalAmount: 81n,
      payload: 'abc',
    });
    expect(
      starsPreCheckoutOf({
        pre_checkout_query: {
          ...update.pre_checkout_query,
          total_amount: 1.5,
          invoice_payload: '',
        },
      }),
    ).toMatchObject({ totalAmount: 0n, payload: '' });
    expect(starsPreCheckoutOf({ message: { text: 'x' } })).toBeNull();
    expect(
      starsPreCheckoutOf({ pre_checkout_query: { ...update.pre_checkout_query, id: undefined } }),
    ).toBeNull();
  });

  it('reads a successful payment only when every field is well-formed', () => {
    const payment = {
      currency: 'XTR',
      total_amount: 81,
      invoice_payload: 'abc',
      telegram_payment_charge_id: 'ch-1',
    };
    const update = { message: { from: { id: 910910 }, successful_payment: payment } };
    expect(hasSuccessfulPayment(update)).toBe(true);
    expect(starsSuccessfulPaymentOf(update)).toEqual({
      payerTelegramUserId: '910910',
      currency: 'XTR',
      totalAmount: 81n,
      payload: 'abc',
      chargeId: 'ch-1',
    });
    for (const broken of [
      { ...payment, telegram_payment_charge_id: '' },
      { ...payment, telegram_payment_charge_id: 'x'.repeat(256) },
      { ...payment, total_amount: 0 },
      { ...payment, invoice_payload: 'x'.repeat(129) },
    ]) {
      const malformed = { message: { from: { id: 910910 }, successful_payment: broken } };
      expect(hasSuccessfulPayment(malformed)).toBe(true);
      expect(starsSuccessfulPaymentOf(malformed)).toBeNull();
    }
    expect(hasSuccessfulPayment({ message: { text: 'hi' } })).toBe(false);
  });

  it('reads a Star amount only as a positive safe integer', () => {
    expect(starsAmountOf(81)).toBe(81n);
    for (const value of [0, -1, 1.5, '81', Number.MAX_SAFE_INTEGER + 2, null]) {
      expect(starsAmountOf(value)).toBeNull();
    }
  });
});

describe('the customer’s routes and /paysupport (A5, A7)', () => {
  it('routes a named-route tap to the order and the provider, and nothing malformed', () => {
    const order = '01900000-0000-7000-8000-0000000000aa';
    const tap = (data: string) => intentOf({ callback_query: { id: 'c', data } });
    expect(tap(`${GATEWAY_ROUTE_PAY_CALLBACK_PREFIX}${order}.TELEGRAM_STARS`)).toMatchObject({
      intent: 'PAY_GATEWAY',
      targetId: order,
      secondaryId: 'TELEGRAM_STARS',
    });
    expect(tap(`gp:${order}.ZARINPAL`).intent).toBe('UNSUPPORTED');
    expect(tap(`gp:${order}.TELEGRAM_STARS.extra`).intent).toBe('UNSUPPORTED');
    expect(tap('gp:not-a-uuid.TELEGRAM_STARS').intent).toBe('UNSUPPORTED');
    // The older button still names only the order.
    expect(tap(`g:${order}`)).toMatchObject({ intent: 'PAY_GATEWAY', targetId: order });
  });

  it('answers /paysupport as the support screen, and lists it in the menu and in help', () => {
    expect(intentOf({ message: { text: '/paysupport' } }).intent).toBe('SUPPORT');
    expect(intentOf({ message: { text: '/paysupport@acme_bot' } }).intent).toBe('SUPPORT');
    expect(BOT_COMMANDS.map((entry) => entry.command)).toContain('paysupport');
    expect(CATALOGUE_FA['bot.help']).toContain('/paysupport');
  });
});

describe('the Codex review of #85', () => {
  it("names two customers' invoices apart when Telegram gives both the same message id (C4)", () => {
    const one = starsCreateOutcome({ outcome: 'SUCCEEDED', messageId: 42 }, 'a', 1n, '910910');
    const two = starsCreateOutcome({ outcome: 'SUCCEEDED', messageId: 42 }, 'b', 1n, '920920');
    expect(one.kind === 'CREATED' && two.kind === 'CREATED').toBe(true);
    if (one.kind === 'CREATED' && two.kind === 'CREATED') {
      expect(one.invoiceId).not.toBe(two.invoiceId);
    }
  });

  it('refuses an invoice title or description override Telegram would refuse (C1)', () => {
    const title = templateDefinition('bot.payment.stars_invoice_title');
    const description = templateDefinition('bot.payment.stars_invoice_description');
    expect(validateTemplateBody(title, 'x'.repeat(32))).toEqual([]);
    expect(validateTemplateBody(title, 'x'.repeat(33)).map((issue) => issue.kind)).toEqual([
      'TOO_LONG',
    ]);
    expect(validateTemplateBody(description, 'x'.repeat(255))).toEqual([]);
    expect(validateTemplateBody(description, 'x'.repeat(256)).map((issue) => issue.kind)).toEqual([
      'TOO_LONG',
    ]);
    // The shipped defaults fit what they are for.
    expect(validateTemplateBody(title, CATALOGUE_FA['bot.payment.stars_invoice_title'])).toEqual(
      [],
    );
    expect(
      validateTemplateBody(description, CATALOGUE_FA['bot.payment.stars_invoice_description']),
    ).toEqual([]);
  });
});
