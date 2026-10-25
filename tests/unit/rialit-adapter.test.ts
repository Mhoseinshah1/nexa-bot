import { describe, expect, it } from 'vitest';
import {
  PAYMENT_GATEWAY_DESCRIPTORS,
  RIALIT_BASE_URL,
  money,
  type ResolvedConversion,
} from '@nexa/contracts';
import { RialitAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/rialit-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';

/**
 * The Rialit adapter against fixtures written from the owner-provided Rialit API document's
 * own examples (version 1: "Create a payment", "Get a payment", "Webhooks", "Errors"). Every
 * request goes to a recording fake `fetch`; nothing leaves the process.
 */

const KEY = 'rl_SYNTHETIC_KEY_do_not_leak_91ab';
const TOKEN = 'hT4xQm9ZkR2vB7nLc8WpY3dJf6GsA1Eu';
const ORDER = 'order-1042';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function adapterWith(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    return answer(call);
  };
  return { adapter: new RialitAdapter({ fetch }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

// The document's examples.
const CREATED = {
  token: TOKEN,
  status: 'pending',
  amount: 250000,
  payer_amount: 250000,
  payer_fee: 0,
};
const STATUS_PAID = {
  token: TOKEN,
  order_id: ORDER,
  payer_id: 123456789,
  amount: 250000,
  payer_amount: 250000,
  payer_fee: 0,
  status: 'paid',
  paid_at: '2026-09-29T08:14:03.271Z',
  reference: '123456789012',
  payer_card: '603799******1234',
};
const request = (overrides: Record<string, unknown> = {}) => ({
  orderId: ORDER,
  amount: 250_000n,
  callbackUrl: 'https://nexa.example/payments/webhook/rialit/t',
  buyerChatId: '123456789',
  presentation: null,
  customerFeeCharged: false,
  ...overrides,
});
const context = { providerOrderId: ORDER, sentAmount: 250_000n, hintedPaymentId: null };
const SAME: ResolvedConversion = { policy: 'SAME_UNIT' } as ResolvedConversion;

describe('the descriptor and the unit', () => {
  it('is the documented host and a Toman, same-unit, unsigned link route that needs the payer id', () => {
    expect(RIALIT_BASE_URL).toBe('https://api.rialit.io/api/v1');
    expect(PAYMENT_GATEWAY_DESCRIPTORS.RIALIT).toMatchObject({
      settlesVia: 'GATEWAY',
      requiresCredentials: true,
      approval: 'INQUIRY',
      invoiceForm: 'LINK',
      requiresBuyerChatId: true,
      webhookSecret: false,
      providerReview: false,
      lateCreditSetting: 'payments.late_credit.rialit_enabled',
    });
    const { adapter } = adapterWith(() => json(500, {}));
    expect(adapter.unit).toBe('IRT');
    expect(adapter.attemptLifetimeMs).toBe(70 * 60_000);
    expect(adapter.providerAmountOf(money(2_500_000n, 'IRR'), SAME)).toBe(250_000n);
    expect(adapter.providerAmountOf(money(2_500_001n, 'IRR'), SAME)).toBeNull();
  });
});

describe('create', () => {
  it('sends exactly amount, order_id and payer_id as JSON numbers with the bearer key, and hands on the pay page', async () => {
    const { adapter, calls } = adapterWith(() => json(201, CREATED));
    const outcome = await adapter.createInvoice(KEY, request());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.rialit.io/api/v1/send');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${KEY}`,
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      amount: 250000,
      order_id: ORDER,
      payer_id: 123456789,
    });
    expect(outcome).toMatchObject({
      kind: 'CREATED',
      invoiceId: TOKEN,
      invoiceUrl: `https://pay.rialit.io/v1/${TOKEN}`,
      status: 'pending',
      requestAmount: 250_000n,
      finalAmount: 250_000n,
    });
    expect(
      JSON.stringify(outcome, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toContain(KEY);
  });

  it('reads a 200 repeat (the same body again) exactly like the 201', async () => {
    const { adapter } = adapterWith(() => json(200, CREATED));
    expect((await adapter.createInvoice(KEY, request())).kind).toBe('CREATED');
  });

  it('refuses out of range BEFORE any call, on the payable', async () => {
    const { adapter, calls } = adapterWith(() => json(201, CREATED));
    for (const amount of [49_999n, 10_000_001n]) {
      expect(await adapter.createInvoice(KEY, request({ amount }))).toEqual({
        kind: 'REFUSED',
        code: 'rialit.AMOUNT_OUT_OF_RANGE:50000:10000000',
        configuration: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('refuses a customer with no positive Telegram id before any call', async () => {
    const { adapter, calls } = adapterWith(() => json(201, CREATED));
    for (const buyerChatId of [null, '-100123', 'abc', '0']) {
      expect((await adapter.createInvoice(KEY, request({ buyerChatId }))).kind).toBe('REFUSED');
    }
    expect(calls).toHaveLength(0);
  });

  describe('the four fee cases (owner rule: only one side charges)', () => {
    const withFee = { ...CREATED, payer_fee: 2500, payer_amount: 252500 };

    it('neither charges: created', async () => {
      const { adapter } = adapterWith(() => json(201, CREATED));
      expect((await adapter.createInvoice(KEY, request())).kind).toBe('CREATED');
    });

    it('Nexa charges, Rialit does not: created', async () => {
      const { adapter } = adapterWith(() => json(201, CREATED));
      expect((await adapter.createInvoice(KEY, request({ customerFeeCharged: true }))).kind).toBe(
        'CREATED',
      );
    });

    it('Rialit charges, Nexa does not: created, with the payer amount carried for the screen', async () => {
      const { adapter } = adapterWith(() => json(201, withFee));
      expect(await adapter.createInvoice(KEY, request())).toMatchObject({
        kind: 'CREATED',
        requestAmount: 250_000n,
        finalAmount: 252_500n,
      });
    });

    it('both charge: refused as configuration, no link, the token kept for the audit', async () => {
      const { adapter } = adapterWith(() => json(201, withFee));
      expect(await adapter.createInvoice(KEY, request({ customerFeeCharged: true }))).toEqual({
        kind: 'REFUSED',
        code: 'rialit.DOUBLE_FEE',
        configuration: true,
        httpStatus: 201,
        providerInvoiceId: TOKEN,
      });
    });

    it('unknown whether Nexa charged reads as charged (the refusing side)', async () => {
      const { adapter } = adapterWith(() => json(201, withFee));
      expect(
        (await adapter.createInvoice(KEY, request({ customerFeeCharged: undefined }))).kind,
      ).toBe('REFUSED');
    });

    it('payer figures that do not add up are refused whoever charges', async () => {
      const { adapter } = adapterWith(() =>
        json(201, { ...CREATED, payer_fee: 2500, payer_amount: 250000 }),
      );
      expect(await adapter.createInvoice(KEY, request())).toMatchObject({
        kind: 'REFUSED',
        code: 'rialit.PAYER_AMOUNT_MISMATCH',
        configuration: true,
      });
    });

    it('unreadable payer figures are refused', async () => {
      const { adapter } = adapterWith(() => json(201, { token: TOKEN, amount: 250000 }));
      expect(await adapter.createInvoice(KEY, request())).toMatchObject({
        kind: 'REFUSED',
        code: 'rialit.PAYER_AMOUNT_UNREADABLE',
      });
    });
  });

  it('maps every documented error status', async () => {
    const cases: [number, unknown, Record<string, unknown>][] = [
      [
        400,
        { error: 'amount must be between 50000 and 10000000 TOMAN' },
        {
          kind: 'REFUSED',
          code: 'rialit.AMOUNT_OUT_OF_RANGE:50000:10000000',
          configuration: false,
        },
      ],
      [
        400,
        { error: 'order_id must be at most 64 bytes' },
        { kind: 'REFUSED', code: 'rialit.INVALID_ORDER_ID', configuration: true },
      ],
      [
        400,
        { error: 'payer_id must be a positive Telegram user ID' },
        { kind: 'REFUSED', code: 'rialit.INVALID_PAYER_ID', configuration: false },
      ],
      [
        400,
        { error: 'decode JSON: json: unknown field "payer_fee_bps"' },
        { kind: 'REFUSED', code: 'rialit.BAD_REQUEST', configuration: true },
      ],
      [
        401,
        { error: 'unauthorized' },
        { kind: 'REFUSED', code: 'rialit.UNAUTHORIZED', configuration: true },
      ],
      [
        403,
        { error: 'IP not allowed' },
        { kind: 'REFUSED', code: 'rialit.IP_NOT_ALLOWED', configuration: true },
      ],
      [
        403,
        { error: 'merchant is not active' },
        { kind: 'REFUSED', code: 'rialit.MERCHANT_INACTIVE', configuration: true },
      ],
      [
        409,
        { error: 'order_id already used with a different amount or payer_id' },
        { kind: 'AMBIGUOUS', code: 'rialit.ORDER_CONFLICT' },
      ],
      [
        429,
        { error: 'rate limit exceeded' },
        { kind: 'RATE_LIMITED', code: 'rialit.RATE_LIMITED', retryAfterMs: 1000 },
      ],
      [502, { error: 'upstream service unavailable' }, { kind: 'UNKNOWN', code: 'http.502' }],
      [503, { error: 'upstream service unavailable' }, { kind: 'UNKNOWN', code: 'http.503' }],
    ];
    for (const [status, body, expected] of cases) {
      const { adapter } = adapterWith(() => json(status, body));
      const outcome = await adapter.createInvoice(KEY, request());
      expect(outcome).toMatchObject(expected);
      // The provider's English never travels on.
      expect(
        JSON.stringify(outcome, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
      ).not.toMatch(/not allowed|unauthorized|must be|already used/u);
    }
  });

  it('a timeout or a lost answer is UNKNOWN, never retried by the adapter', async () => {
    const { adapter, calls } = adapterWith(() => Promise.reject(new Error('socket hang up')));
    const outcome = await adapter.createInvoice(KEY, request());
    expect(outcome.kind).toBe('UNKNOWN');
    expect(calls).toHaveLength(1);
    const html = adapterWith(() => new Response('<html>bad gateway</html>', { status: 200 }));
    expect((await html.adapter.createInvoice(KEY, request())).kind).toBe('UNKNOWN');
  });

  it('a 2xx for another amount, or with an unsafe token, is UNKNOWN (never a link)', async () => {
    const other = adapterWith(() =>
      json(200, { ...CREATED, amount: 260000, payer_amount: 260000 }),
    );
    expect(await other.adapter.createInvoice(KEY, request())).toMatchObject({
      kind: 'UNKNOWN',
      code: 'nexa.amount_mismatch',
    });
    const unsafe = adapterWith(() => json(201, { ...CREATED, token: '../../x' }));
    expect((await unsafe.adapter.createInvoice(KEY, request())).kind).toBe('UNKNOWN');
  });
});

describe('the status read', () => {
  it('GETs /status/{token} and approves only the documented paid answer for this attempt', async () => {
    const { adapter, calls } = adapterWith(() => json(200, STATUS_PAID));
    const outcome = await adapter.inquire(KEY, TOKEN, context);
    expect(calls[0]?.url).toBe(`https://api.rialit.io/api/v1/status/${TOKEN}`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.init.body).toBeUndefined();
    expect(outcome).toMatchObject({
      kind: 'OBSERVED',
      invoiceId: TOKEN,
      orderId: ORDER,
      status: 'paid',
      paid: true,
      verdict: 'APPROVED',
    });
  });

  it('pending, expired and cancelled are all OPEN', async () => {
    for (const status of ['pending', 'expired', 'cancelled']) {
      const { adapter } = adapterWith(() => json(200, { ...STATUS_PAID, status }));
      expect(await adapter.inquire(KEY, TOKEN, context)).toMatchObject({
        kind: 'OBSERVED',
        status,
        paid: false,
        verdict: 'OPEN',
      });
    }
  });

  it('a paid answer for another amount is a MISMATCH under our order id', async () => {
    const { adapter } = adapterWith(() =>
      json(200, { ...STATUS_PAID, order_id: 'someone-else', amount: 250000 }),
    );
    expect(await adapter.inquire(KEY, TOKEN, context)).toMatchObject({
      verdict: 'MISMATCH',
      orderId: ORDER,
      mismatchReason: 'PROVIDER_ORDER_ID_MISMATCH',
    });
  });

  it('maps the documented errors: 404, 401, 403, 429, 5xx', async () => {
    const cases: [number, unknown, Record<string, unknown>][] = [
      [404, { error: 'payment not found' }, { kind: 'NOT_FOUND', code: 'rialit.NOT_FOUND' }],
      [401, { error: 'unauthorized' }, { kind: 'CONFIGURATION', code: 'rialit.UNAUTHORIZED' }],
      [403, { error: 'IP not allowed' }, { kind: 'CONFIGURATION', code: 'rialit.IP_NOT_ALLOWED' }],
      [429, { error: 'rate limit exceeded' }, { kind: 'RATE_LIMITED', retryAfterMs: 1000 }],
      [502, { error: 'upstream service unavailable' }, { kind: 'FAILED', code: 'http.502' }],
    ];
    for (const [status, body, expected] of cases) {
      const { adapter } = adapterWith(() => json(status, body));
      expect(await adapter.inquire(KEY, TOKEN, context)).toMatchObject(expected);
    }
  });

  it('never asks about an unsafe token', async () => {
    const { adapter, calls } = adapterWith(() => json(200, STATUS_PAID));
    expect((await adapter.inquire(KEY, '../x', context)).kind).toBe('FAILED');
    expect(calls).toHaveLength(0);
  });
});

describe('webhooks', () => {
  const { adapter } = adapterWith(() => json(500, {}));
  const event = (type: string, status: string) => ({
    event_id: '0199947e-6a1c-7d2b-9f3e-4c5b6a7d8e9f',
    type,
    created_at: '2026-09-29T08:14:05.482913Z',
    data: {
      id: TOKEN,
      order_id: ORDER,
      payer_id: 123456789,
      status,
      amount: 250000,
      payer_amount: 250000,
      payer_fee: 0,
    },
  });

  it('reads each payment event as a hint: the token, the order id, the status, the delivery id', () => {
    for (const [type, status] of [
      ['payment.paid', 'paid'],
      ['payment.expired', 'expired'],
      ['payment.cancelled', 'cancelled'],
    ] as const) {
      expect(adapter.parseWebhook(event(type, status), 'hdr-1')).toEqual({
        orderId: ORDER,
        invoiceId: TOKEN,
        status,
        deliveryId: 'hdr-1',
        creditAmount: null,
      });
    }
    // Without the header, the body's own event id.
    expect(adapter.parseWebhook(event('payment.paid', 'paid'), undefined)?.deliveryId).toBe(
      '0199947e-6a1c-7d2b-9f3e-4c5b6a7d8e9f',
    );
  });

  it('recognises webhook.test as the dashboard probe, and nothing else as one', () => {
    const test = {
      event_id: '019994b0-5d6e-7f80-9a1b-2c3d4e5f6a7b',
      type: 'webhook.test',
      created_at: '2026-09-29T09:02:40.317Z',
      data: { merchant_id: '0198f2c4-8a1b-7c2d-9e3f-4a5b6c7d8e9f' },
    };
    expect(adapter.isWebhookProbe(test)).toBe(true);
    expect(adapter.parseWebhook(test, undefined)).toBeNull();
    expect(adapter.isWebhookProbe(event('payment.paid', 'paid'))).toBe(false);
  });

  it('refuses a body that is not the documented shape', () => {
    expect(adapter.parseWebhook({ nothing: true }, undefined)).toBeNull();
    expect(adapter.parseWebhook({ data: { id: '../x', order_id: ORDER } }, undefined)).toBeNull();
  });
});
