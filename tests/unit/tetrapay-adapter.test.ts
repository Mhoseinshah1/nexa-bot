import { describe, expect, it } from 'vitest';
import {
  PAYMENT_GATEWAY_DESCRIPTORS,
  TETRAPAY_BASE_URL,
  money,
  type ResolvedConversion,
} from '@nexa/contracts';
import {
  TetraPayAdapter,
  retryAfterMsOf,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tetrapay-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';

/**
 * The TetraPay adapter against the documentation's own examples (`https://tetra98.com/docs`,
 * §3, §7, §9). Every request goes to a recording fake `fetch`; nothing leaves the process.
 */

const KEY = 'tp_live_SYNTHETIC_KEY_do_not_leak_77aa';
const TOKEN = 'q9Xk2VbR7tLmN4pA8sWcYg';
const ORDER = 'ORD-10482';
const CALLBACK = 'https://t.me/nexa_bot?start=tp-0190f2a4-7c3e-7d11-9a55-1f2e3d4c5b6a';

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
  return { adapter: new TetraPayAdapter({ fetch }), calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

// The documentation's examples, verbatim.
const CREATE_201 = {
  token: TOKEN,
  payment_url: `https://tetrapay.online/pay/${TOKEN}`,
  amount: '12500000',
  payable_amount: '12562500',
  expires_at: '2026-09-29T10:30:00.000Z',
};
const VERIFY_PAID = {
  token: TOKEN,
  status: 'paid',
  order_id: ORDER,
  amount: '12500000',
  payable_amount: '12562500',
  received_amount: '12562500',
  net_amount: '12437500',
  fee_total: '125000',
  method: 'online',
  paid_at: '2026-09-29T10:21:44.000Z',
  verified_before: false,
};
const create = { orderId: ORDER, amount: 12_500_000n, callbackUrl: CALLBACK };
const request = (overrides: Partial<typeof create> = {}) => ({
  ...create,
  ...overrides,
  buyerChatId: '910911',
  presentation: null,
});
const context = { providerOrderId: ORDER, sentAmount: 12_500_000n, hintedPaymentId: null };

describe('the descriptor and the unit', () => {
  it('is the documented host and a rial, same-unit, optional-secret link route', () => {
    expect(TETRAPAY_BASE_URL).toBe('https://api.tetra98.com/api/v1');
    const d = PAYMENT_GATEWAY_DESCRIPTORS.TETRAPAY;
    expect(d).toMatchObject({
      settlesVia: 'GATEWAY',
      approval: 'INQUIRY',
      invoiceForm: 'LINK',
      webhookSecret: true,
      webhookSecretOptional: true,
      returnToBot: true,
    });
    const { adapter } = adapterWith(() => json(200, {}));
    expect(adapter.unit).toBe('IRR');
    expect(adapter.callBudgetPerMinute).toBeLessThanOrEqual(60);
    const same: ResolvedConversion = { policy: 'SAME_UNIT' };
    expect(adapter.providerAmountOf(money(1_250_000n, 'IRT'), same)).toBe(12_500_000n);
    expect(
      adapter.providerAmountOf(money(1_250_000n, 'IRT'), { policy: 'FIXED_RATE', rateMinor: 1n }),
    ).toBeNull();
  });
});

describe('create (POST /payments)', () => {
  it('sends exactly the documented fields, the rial amount as a string, and the Bearer key', async () => {
    const { adapter, calls } = adapterWith(() => json(201, CREATE_201));
    const outcome = await adapter.createInvoice(KEY, request());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.tetra98.com/api/v1/payments');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      amount: '12500000',
      order_id: ORDER,
      callback_url: CALLBACK,
      allow_partial: false,
    });
    // No card saving, no per-payment webhook, and the key nowhere but the header.
    expect(String(calls[0]?.init.body)).not.toMatch(/customer_phone|customer_email|webhook_url/u);
    expect(String(calls[0]?.init.body)).not.toContain(KEY);
    expect(calls[0]?.url).not.toContain(KEY);
    expect(calls[0]?.init.redirect).toBe('error');
    expect(outcome).toMatchObject({
      kind: 'CREATED',
      invoiceId: TOKEN,
      orderId: ORDER,
      invoiceUrl: `https://tetrapay.online/pay/${TOKEN}`,
      requestAmount: 12_500_000n,
      finalAmount: 12_562_500n,
    });
  });

  it('treats a repeated order id with the same amount (200) as the same link', async () => {
    const { adapter } = adapterWith(() => json(200, CREATE_201));
    expect(await adapter.createInvoice(KEY, request())).toMatchObject({ kind: 'CREATED' });
  });

  it('never accepts a link for another amount, nor a token that cannot ride a path, nor a non-https link', async () => {
    const other = await adapterWith(() =>
      json(200, { ...CREATE_201, amount: '999' }),
    ).adapter.createInvoice(KEY, request());
    expect(other).toEqual({ kind: 'UNKNOWN', code: 'nexa.amount_mismatch' });
    const unsafe = await adapterWith(() =>
      json(201, { ...CREATE_201, token: '../admin' }),
    ).adapter.createInvoice(KEY, request());
    expect(unsafe).toEqual({ kind: 'UNKNOWN', code: 'nexa.invoice_id_unsafe' });
    const http = await adapterWith(() =>
      json(201, { ...CREATE_201, payment_url: 'http://evil.example/pay' }),
    ).adapter.createInvoice(KEY, request());
    expect(http).toMatchObject({ kind: 'CREATED', invoiceUrl: null, linkRejected: true });
  });

  it('refuses a create with no return link as configuration, sending nothing', async () => {
    const { adapter, calls } = adapterWith(() => json(201, CREATE_201));
    expect(await adapter.createInvoice(KEY, request({ callbackUrl: null as never }))).toEqual({
      kind: 'REFUSED',
      code: 'nexa.no_return_url',
      configuration: true,
    });
    expect(calls).toHaveLength(0);
  });

  const error = (status: number, body: Record<string, unknown>, headers = {}) =>
    adapterWith(() =>
      json(status, { error: { message: 'x', ...body } }, headers),
    ).adapter.createInvoice(KEY, request());

  it('maps every documented error code (§9), by HTTP status and code', async () => {
    expect(await error(401, { code: 'UNAUTHORIZED' })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.UNAUTHORIZED',
      configuration: true,
    });
    expect(await error(403, { code: 'GATEWAY_SUSPENDED' })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.GATEWAY_SUSPENDED',
      configuration: true,
    });
    expect(await error(403, { code: 'NO_METHOD_AVAILABLE' })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.NO_METHOD_AVAILABLE',
      configuration: true,
    });
    expect(await error(404, { code: 'NOT_FOUND' })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.NOT_FOUND',
      configuration: false,
    });
    expect(await error(409, { code: 'ORDER_CONFLICT' })).toMatchObject({
      kind: 'AMBIGUOUS',
      code: 'tetrapay.ORDER_CONFLICT',
    });
    expect(await error(422, { code: 'INVALID_CALLBACK' })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.INVALID_CALLBACK',
      configuration: true,
    });
    expect(await error(422, { code: 'INVALID_WEBHOOK' })).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
    expect(await error(422, { code: 'WEBHOOK_NOT_CONFIGURED' })).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
    expect(await error(422, { code: 'VALIDATION', fields: ['amount'] })).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.VALIDATION',
      configuration: false,
    });
    expect(await error(415, { code: 'UNSUPPORTED_MEDIA_TYPE' })).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
    expect(await error(400, { code: 'BAD_JSON' })).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
    // A server error is never a refusal: the payment may exist.
    expect(await error(500, { code: 'INTERNAL' })).toEqual({ kind: 'UNKNOWN', code: 'http.500' });
  });

  it('shows the provider min/max converted from rial to Toman in AMOUNT_OUT_OF_RANGE', async () => {
    expect(
      await error(422, { code: 'AMOUNT_OUT_OF_RANGE', min: '10000', max: '1000000000' }),
    ).toEqual({
      kind: 'REFUSED',
      code: 'tetrapay.AMOUNT_OUT_OF_RANGE:1000:100000000',
      configuration: false,
      httpStatus: 422,
    });
    // A bound that is not a whole Toman, or absent, is 0 (not stated), never rounded.
    expect(await error(422, { code: 'AMOUNT_OUT_OF_RANGE', min: '10005' })).toMatchObject({
      code: 'tetrapay.AMOUNT_OUT_OF_RANGE:0:0',
    });
  });

  it('keeps the daily limit apart from the rate limit although both are 429, and asks to hide the route', async () => {
    expect(
      await error(
        429,
        { code: 'DAILY_LIMIT_REACHED', kind: 'links', limit: 500 },
        { 'retry-after': '3600' },
      ),
    ).toMatchObject({
      kind: 'REFUSED',
      code: 'tetrapay.DAILY_LIMIT_REACHED',
      configuration: false,
      routeEffect: 'HIDE_UNTIL_TEHRAN_MIDNIGHT',
    });
    expect(
      await error(429, { code: 'RATE_LIMITED', retryAfter: 30 }, { 'retry-after': '30' }),
    ).toEqual({
      kind: 'RATE_LIMITED',
      code: 'tetrapay.RATE_LIMITED',
      httpStatus: 429,
      retryAfterMs: 30_000,
    });
  });

  it('honours Retry-After from the header, else the body, bounded; reads an HTTP date; ignores junk', async () => {
    expect(await error(429, { code: 'RATE_LIMITED', retryAfter: 12 })).toMatchObject({
      retryAfterMs: 12_000,
    });
    expect(await error(429, { code: 'RATE_LIMITED' }, { 'retry-after': '999999' })).toMatchObject({
      retryAfterMs: 3_600_000,
    });
    expect(
      await error(429, { code: 'RATE_LIMITED' }, { 'retry-after': 'soon' }),
    ).not.toHaveProperty('retryAfterMs');
    const now = new Date('2026-09-29T10:00:00.000Z');
    expect(retryAfterMsOf('Tue, 29 Sep 2026 10:01:00 GMT', now)).toBe(60_000);
    expect(retryAfterMsOf('0', now)).toBeNull();
    expect(retryAfterMsOf(null, now)).toBeNull();
  });

  it('is UNKNOWN for no answer, an unreadable body, and an unreadable 4xx - never a refusal', async () => {
    const down = new TetraPayAdapter({ fetch: () => Promise.reject(new Error('socket hang up')) });
    expect(await down.createInvoice(KEY, request())).toMatchObject({ kind: 'UNKNOWN' });
    const html = await adapterWith(
      () => new Response('<html>', { status: 502 }),
    ).adapter.createInvoice(KEY, request());
    expect(html).toMatchObject({ kind: 'UNKNOWN' });
    expect(
      await adapterWith(() => json(400, { nope: 1 })).adapter.createInvoice(KEY, request()),
    ).toEqual({ kind: 'UNKNOWN', code: 'http.400' });
    // A key refusal is configuration whatever the body says.
    expect(
      await adapterWith(() => json(401, {})).adapter.createInvoice(KEY, request()),
    ).toMatchObject({ kind: 'REFUSED', configuration: true });
    expect(
      await adapterWith(() => json(201, { nope: 1 })).adapter.createInvoice(KEY, request()),
    ).toMatchObject({ kind: 'UNKNOWN' });
  });
});

describe('verify (POST /payments/{token}/verify) - the only settlement authority', () => {
  it('posts with no body to the token path and approves the documented paid answer', async () => {
    const { adapter, calls } = adapterWith(() => json(200, VERIFY_PAID));
    const outcome = await adapter.inquire(KEY, TOKEN, context);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.tetra98.com/api/v1/payments/${TOKEN}/verify`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBeUndefined();
    expect((calls[0]?.init.headers as Record<string, string>)['authorization']).toBe(
      `Bearer ${KEY}`,
    );
    expect(outcome).toMatchObject({
      kind: 'OBSERVED',
      invoiceId: TOKEN,
      orderId: ORDER,
      status: 'paid',
      paid: true,
      verdict: 'APPROVED',
      requestAmount: 12_500_000n,
      method: 'online',
    });
  });

  it('never calls the display-only GET', async () => {
    const { adapter, calls } = adapterWith(() => json(200, VERIFY_PAID));
    await adapter.inquire(KEY, TOKEN, context);
    expect(calls.every((call) => call.init.method === 'POST')).toBe(true);
  });

  it('a repeated verify of a paid link (verified_before) is the same approval - the ledger key decides the rest', async () => {
    const { adapter } = adapterWith(() => json(200, { ...VERIFY_PAID, verified_before: true }));
    expect(await adapter.inquire(KEY, TOKEN, context)).toMatchObject({ verdict: 'APPROVED' });
  });

  it('holds paid for another amount or another order id, and does not approve an unpaid link', async () => {
    const amount = await adapterWith(() =>
      json(200, { ...VERIFY_PAID, amount: '12500010' }),
    ).adapter.inquire(KEY, TOKEN, context);
    expect(amount).toMatchObject({
      kind: 'OBSERVED',
      verdict: 'MISMATCH',
      paid: false,
      mismatchReason: 'PROVIDER_AMOUNT_MISMATCH',
    });
    const order = await adapterWith(() =>
      json(200, { ...VERIFY_PAID, order_id: 'SOMEONE-ELSE' }),
    ).adapter.inquire(KEY, TOKEN, context);
    // Reported under OUR order id (the token we asked is ours), so the lane's identity gate does
    // not swallow it and the hold workflow runs; the foreign id is never evidence.
    expect(order).toMatchObject({
      kind: 'OBSERVED',
      orderId: ORDER,
      verdict: 'MISMATCH',
      paid: false,
      mismatchReason: 'PROVIDER_ORDER_ID_MISMATCH',
    });
    // A NON-paid answer for a foreign id stays as it was: the identity gate refuses it.
    const foreignPending = await adapterWith(() =>
      json(200, { ...VERIFY_PAID, status: 'pending', order_id: 'SOMEONE-ELSE' }),
    ).adapter.inquire(KEY, TOKEN, context);
    expect(foreignPending).toMatchObject({ orderId: 'SOMEONE-ELSE', verdict: 'OPEN' });
    const pending = await adapterWith(() =>
      json(200, {
        ...VERIFY_PAID,
        status: 'pending',
        received_amount: null,
        method: null,
        paid_at: null,
      }),
    ).adapter.inquire(KEY, TOKEN, context);
    expect(pending).toMatchObject({ verdict: 'OPEN', paid: false });
    const expired = await adapterWith(() =>
      json(200, { ...VERIFY_PAID, status: 'expired', received_amount: null }),
    ).adapter.inquire(KEY, TOKEN, context);
    expect(expired).toMatchObject({ verdict: 'UNSUCCESSFUL' });
  });

  it('classifies the verify errors: rate limit with Retry-After, not found, key refusal, the rest as failures', async () => {
    const err = (status: number, body: Record<string, unknown>, headers = {}) =>
      adapterWith(() =>
        json(status, { error: { message: 'x', ...body } }, headers),
      ).adapter.inquire(KEY, TOKEN, context);
    expect(await err(429, { code: 'RATE_LIMITED' }, { 'retry-after': '20' })).toEqual({
      kind: 'RATE_LIMITED',
      code: 'tetrapay.RATE_LIMITED',
      retryAfterMs: 20_000,
    });
    expect(await err(404, { code: 'NOT_FOUND' })).toEqual({
      kind: 'NOT_FOUND',
      code: 'tetrapay.NOT_FOUND',
    });
    expect(await err(401, { code: 'UNAUTHORIZED' })).toEqual({
      kind: 'CONFIGURATION',
      code: 'tetrapay.UNAUTHORIZED',
    });
    // GATEWAY_SUSPENDED refuses a create only: on a verify it is just a failed read, asked again.
    expect(await err(403, { code: 'GATEWAY_SUSPENDED' })).toEqual({
      kind: 'FAILED',
      code: 'tetrapay.GATEWAY_SUSPENDED',
    });
    expect(await err(500, { code: 'INTERNAL' })).toEqual({
      kind: 'FAILED',
      code: 'tetrapay.INTERNAL',
    });
  });

  it('fails closed on an answer it cannot read, and on a token that cannot ride a path', async () => {
    expect(
      await adapterWith(() => json(200, { nope: true })).adapter.inquire(KEY, TOKEN, context),
    ).toMatchObject({ kind: 'FAILED' });
    const { adapter, calls } = adapterWith(() => json(200, VERIFY_PAID));
    expect(await adapter.inquire(KEY, '../../x', context)).toEqual({
      kind: 'FAILED',
      code: 'nexa.invoice_id_unsafe',
    });
    expect(await adapter.inquire(KEY, TOKEN)).toEqual({
      kind: 'FAILED',
      code: 'nexa.no_inquiry_context',
    });
    expect(calls).toHaveLength(0);
  });
});

describe('webhook shape (§7)', () => {
  const body = {
    event: 'payment.paid',
    event_id: '6f1c2a9e-3b7d-4e21-9a0c-5d8e4f7b1a23',
    token: TOKEN,
    status: 'paid',
    order_id: ORDER,
    amount: '12500000',
  };
  const { adapter } = adapterWith(() => json(200, {}));

  it('reads only the locators and the event id, preferring the header', () => {
    expect(adapter.parseWebhook(body, 'header-event')).toEqual({
      orderId: ORDER,
      invoiceId: TOKEN,
      status: 'paid',
      deliveryId: 'header-event',
      creditAmount: null,
    });
    expect(adapter.parseWebhook(body, undefined)?.deliveryId).toBe(body.event_id);
  });

  it('is not a notification without an order id and a token', () => {
    expect(adapter.parseWebhook({ ...body, order_id: undefined }, undefined)).toBeNull();
    expect(adapter.parseWebhook({ ...body, token: undefined }, undefined)).toBeNull();
    expect(adapter.parseWebhook('nope', undefined)).toBeNull();
    expect(adapter.parseWebhook(null, undefined)).toBeNull();
  });
});
