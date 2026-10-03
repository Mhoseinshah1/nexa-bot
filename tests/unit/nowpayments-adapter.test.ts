import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FX_POLICY_VERSION,
  NOWPAYMENTS_BASE_URL,
  NOWPAYMENTS_SIGNATURE_HEADER,
  NOWPAYMENTS_STATUSES,
  PAYMENT_GATEWAY_DESCRIPTORS,
  money,
  type FxQuote,
  type ResolvedConversion,
} from '@nexa/contracts';
import { NowPaymentsAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  canonicalIpnBodies,
  sortDeep,
  verifyIpnSignature,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/nowpayments-signature';
import {
  centsOfPriceAmount,
  nowpaymentsOrderId,
  nowpaymentsVerdict,
  priceAmountOfCents,
  strongestJudgement,
  NOWPAYMENTS_ORDER_ID_RANDOM_BYTES,
} from '../../apps/api/src/modules/commerce/payments/domain/nowpayments';
import { reconciliationEvidenceAllows } from '../../apps/api/src/modules/commerce/payments/domain/gateway-reconciliation';

/**
 * NOWPayments — the adapter, the IPN signature and the pure rules
 * (`docs/nowpayments-gateway-audit.md`). Every request goes to a recording fake `fetch`;
 * nothing leaves the process.
 */

const API_KEY = 'np_live_SECRET_do_not_leak_4b8e';
const IPN_SECRET = 'ipn_SECRET_never_logged_77aa';
const ORDER_ID = 'NPAAAAAAAAAAAAAAAAAA';
const INVOICE_ID = '4522625843';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown> | null;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = {
        url,
        init,
        body:
          init.body === undefined
            ? null
            : (JSON.parse(String(init.body)) as Record<string, unknown>),
      };
      calls.push(call);
      return answer(call);
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function adapterWith(answer: (call: Call) => Response | Promise<Response>) {
  const fake = fakeFetch(answer);
  return { adapter: new NowPaymentsAdapter({ fetch: fake.fetch }), calls: fake.calls };
}

const sign = (body: unknown, secret = IPN_SECRET) =>
  createHmac('sha512', secret)
    .update(JSON.stringify(sortDeep(body)))
    .digest('hex');

const PAYMENT = {
  payment_id: 5077125051,
  payment_status: 'finished',
  pay_address: '0xd1cDE08A07cD25adEbEd35c3867a59228C09B606',
  price_amount: 12.34,
  price_currency: 'usd',
  pay_amount: 155.38559757,
  actually_paid: 155.38559757,
  pay_currency: 'mana',
  order_id: ORDER_ID,
  invoice_id: Number(INVOICE_ID),
  purchase_id: '6084744717',
  created_at: '2021-04-12T14:22:54.942Z',
  updated_at: '2021-04-12T14:23:06.244Z',
  outcome_amount: 1131.7812095,
  outcome_currency: 'trx',
  fee: { currency: 'mana', depositFee: 0.09, withdrawalFee: 0, serviceFee: 0 },
};

const context = (overrides: { hintedPaymentId?: string | null; sentAmount?: bigint } = {}) => ({
  providerOrderId: ORDER_ID,
  sentAmount: overrides.sentAmount ?? 1234n,
  hintedPaymentId: overrides.hintedPaymentId === undefined ? null : overrides.hintedPaymentId,
});

describe('the IPN signature (HMAC-SHA512 over the key-sorted body)', () => {
  it('verifies a valid signature', () => {
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, sign(PAYMENT))).toBe(true);
  });

  it('refuses a tampered body: one changed value is a different signature', () => {
    const signature = sign(PAYMENT);
    expect(
      verifyIpnSignature(IPN_SECRET, { ...PAYMENT, payment_status: 'waiting' }, signature),
    ).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, { ...PAYMENT, price_amount: 12.35 }, signature)).toBe(
      false,
    );
    expect(
      verifyIpnSignature(
        IPN_SECRET,
        { ...PAYMENT, fee: { ...PAYMENT.fee, serviceFee: 1 } },
        signature,
      ),
    ).toBe(false);
  });

  it('does not depend on the order the keys arrived in, at any depth', () => {
    const reordered = Object.fromEntries(Object.entries(PAYMENT).reverse());
    (reordered as Record<string, unknown>).fee = {
      serviceFee: 0,
      withdrawalFee: 0,
      depositFee: 0.09,
      currency: 'mana',
    };
    expect(verifyIpnSignature(IPN_SECRET, reordered, sign(PAYMENT))).toBe(true);
  });

  it('refuses a missing, empty, malformed or wrong-length header', () => {
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, undefined)).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, '')).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, sign(PAYMENT).slice(0, 127))).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, `${sign(PAYMENT).slice(0, 127)}z`)).toBe(false);
  });

  it('refuses another secret, an empty secret and a body that is not an object', () => {
    expect(verifyIpnSignature('another-secret', PAYMENT, sign(PAYMENT))).toBe(false);
    expect(verifyIpnSignature('', PAYMENT, sign(PAYMENT, ''))).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, [PAYMENT], sign([PAYMENT]))).toBe(false);
    expect(verifyIpnSignature(IPN_SECRET, null, sign(null))).toBe(false);
  });

  it('accepts the hex in either case, and the reference’s top-level replacer form too', () => {
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, sign(PAYMENT).toUpperCase())).toBe(true);
    const replacer = JSON.stringify(PAYMENT, Object.keys(PAYMENT).sort());
    const legacy = createHmac('sha512', IPN_SECRET).update(replacer).digest('hex');
    expect(canonicalIpnBodies(PAYMENT)).toContain(replacer);
    expect(verifyIpnSignature(IPN_SECRET, PAYMENT, legacy)).toBe(true);
  });
});

describe('the status mapping (only `finished` for exactly the invoiced price approves)', () => {
  const judge = (status: string, price: unknown = 12.34, currency: unknown = 'usd') =>
    nowpaymentsVerdict({ status, priceAmount: price, priceCurrency: currency }, 1234n);

  it('maps every documented status', () => {
    const table = Object.fromEntries(
      NOWPAYMENTS_STATUSES.map((status) => {
        const { verdict, fundsDetected } = judge(status);
        return [status, [verdict, fundsDetected]];
      }),
    );
    expect(table).toEqual({
      waiting: ['OPEN', false],
      confirming: ['OPEN', true],
      confirmed: ['OPEN', true],
      sending: ['OPEN', true],
      partially_paid: ['MISMATCH', true],
      finished: ['APPROVED', true],
      // One payment ended; the hosted invoice can take another. The deadline decides.
      failed: ['OPEN', false],
      refunded: ['OPEN', false],
      expired: ['OPEN', false],
    });
  });

  it('never approves a finished payment for another price, currency or an unreadable price', () => {
    expect(judge('finished', 12.33).verdict).toBe('MISMATCH');
    expect(judge('finished', 12.35).verdict).toBe('MISMATCH');
    expect(judge('finished', 12.34, 'eur').verdict).toBe('MISMATCH');
    expect(judge('finished', 12.34, null).verdict).toBe('MISMATCH');
    expect(judge('finished', '12.345').verdict).toBe('MISMATCH');
    expect(
      nowpaymentsVerdict(
        { status: 'finished', priceAmount: undefined, priceCurrency: 'usd' },
        1234n,
      ).verdict,
    ).toBe('MISMATCH');
    expect(judge('finished', 12.34, 'USD').verdict).toBe('APPROVED');
    expect(judge('finished', '12.34').verdict).toBe('APPROVED');
  });

  it('records an undocumented status as open, never an approval or a failure', () => {
    expect(judge('completed')).toEqual({ verdict: 'OPEN', fundsDetected: false });
    expect(judge('paid')).toEqual({ verdict: 'OPEN', fundsDetected: false });
  });

  it('ranks the strongest payment under one invoice', () => {
    const waiting = { id: 'w', ...judge('waiting') };
    const confirming = { id: 'c', ...judge('confirming') };
    const partial = { id: 'p', ...judge('partially_paid') };
    const finished = { id: 'f', ...judge('finished') };
    expect(strongestJudgement([waiting, confirming])?.id).toBe('c');
    expect(strongestJudgement([confirming, partial])?.id).toBe('p');
    expect(strongestJudgement([partial, finished, waiting])?.id).toBe('f');
    expect(strongestJudgement([])).toBeNull();
  });
});

describe('exact money: US cents, never a float decision', () => {
  it('writes cents as the price the provider reads, and reads it back exactly', () => {
    expect(priceAmountOfCents(1234n)).toBe(12.34);
    expect(priceAmountOfCents(1200n)).toBe(12);
    expect(priceAmountOfCents(1230n)).toBe(12.3);
    expect(priceAmountOfCents(5n)).toBe(0.05);
    expect(priceAmountOfCents(0n)).toBeNull();
    expect(priceAmountOfCents(-1n)).toBeNull();
    for (const cents of [1n, 99n, 100n, 101n, 123456789n, 900_719_925_474_099n]) {
      expect(centsOfPriceAmount(priceAmountOfCents(cents))).toBe(cents);
    }
  });

  it('refuses a price with three decimals, an exponent, a sign or a non-number', () => {
    expect(centsOfPriceAmount(12.345)).toBeNull();
    expect(centsOfPriceAmount(1e-7)).toBeNull();
    expect(centsOfPriceAmount(-1)).toBeNull();
    expect(centsOfPriceAmount('1e3')).toBeNull();
    expect(centsOfPriceAmount(Number.NaN)).toBeNull();
    expect(centsOfPriceAmount(true)).toBeNull();
  });

  it('prices from the central USDT quote at 100 cents per USDT, rounded UP to the cent', () => {
    const adapter = new NowPaymentsAdapter();
    const quote: FxQuote = {
      baseAsset: 'USDT',
      quoteCurrency: 'IRT',
      side: 'SELL_USDT_TO_RECEIVE_FIAT',
      rate: { mantissa: 100_000n, scale: 0 },
      source: 'WALLEX',
      sourceAt: null,
      fetchedAt: new Date('2026-10-02T00:00:00Z'),
      ageSeconds: 0,
      state: 'FRESH',
      quoteId: 'q',
      policyVersion: FX_POLICY_VERSION,
    };
    const central: ResolvedConversion = {
      policy: 'CENTRAL_FX',
      quote,
      unitRatio: PAYMENT_GATEWAY_DESCRIPTORS.NOWPAYMENTS.conversion.fixedUnitRatio ?? {
        mantissa: 0n,
        scale: 0,
      },
    };
    // 1,000,000 Toman at 100,000 Toman/USDT is exactly 10 dollars.
    expect(adapter.providerAmountOf(money(1_000_000n, 'IRT'), central)).toBe(1000n);
    // One Toman more is a fraction of a cent more: the ceiling.
    expect(adapter.providerAmountOf(money(1_000_001n, 'IRT'), central)).toBe(1001n);
    // Never by the same unit or an operator's rate, and never across currencies.
    expect(adapter.providerAmountOf(money(1_000_000n, 'IRT'), { policy: 'SAME_UNIT' })).toBeNull();
    expect(
      adapter.providerAmountOf(money(1_000_000n, 'IRT'), { policy: 'FIXED_RATE', rateMinor: 10n }),
    ).toBeNull();
    expect(adapter.providerAmountOf(money(1_000_000n, 'IRR'), central)).toBeNull();
  });

  it('has a fixed ratio and no ratio setting, mode or operator rate', () => {
    expect(PAYMENT_GATEWAY_DESCRIPTORS.NOWPAYMENTS.conversion).toEqual({
      policies: ['CENTRAL_FX'],
      fxBaseAsset: 'USDT',
      modeSetting: null,
      unitRatioSetting: null,
      fixedUnitRatio: { mantissa: 100n, scale: 0 },
    });
  });
});

describe('creating the hosted invoice', () => {
  const request = {
    orderId: ORDER_ID,
    amount: 1234n,
    callbackUrl: 'https://bot.example/payments/webhook/nowpayments/t1',
    buyerChatId: '123',
    presentation: null,
  };

  it('sends the documented fields with the key in its header, and NEVER a pay_currency', async () => {
    const { adapter, calls } = adapterWith(() =>
      json(200, {
        id: INVOICE_ID,
        order_id: ORDER_ID,
        invoice_url: 'https://nowpayments.io/payment/?iid=1',
        price_amount: '12.34',
      }),
    );
    const outcome = await adapter.createInvoice(API_KEY, request);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${NOWPAYMENTS_BASE_URL}/v1/invoice`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect((calls[0]?.init.headers as Record<string, string>)['x-api-key']).toBe(API_KEY);
    expect(calls[0]?.body).toEqual({
      price_amount: 12.34,
      price_currency: 'usd',
      order_id: ORDER_ID,
      ipn_callback_url: request.callbackUrl,
    });
    expect(calls[0]?.body).not.toHaveProperty('pay_currency');
    expect(calls[0]?.url).not.toContain(API_KEY);
    expect(outcome).toEqual({
      kind: 'CREATED',
      invoiceId: INVOICE_ID,
      orderId: ORDER_ID,
      invoiceUrl: 'https://nowpayments.io/payment/?iid=1',
      webInvoiceUrl: null,
      status: null,
      requestAmount: 1234n,
      finalAmount: null,
    });
  });

  it('omits the callback when there is no public origin, and normalises a numeric id', async () => {
    const { adapter, calls } = adapterWith(() =>
      json(201, {
        id: Number(INVOICE_ID),
        order_id: ORDER_ID,
        invoice_url: 'https://nowpayments.io/payment/?iid=1',
      }),
    );
    const outcome = await adapter.createInvoice(API_KEY, { ...request, callbackUrl: null });
    expect(calls[0]?.body).not.toHaveProperty('ipn_callback_url');
    expect(outcome.kind === 'CREATED' && outcome.invoiceId).toBe(INVOICE_ID);
  });

  it('classifies every answer without ever carrying the key', async () => {
    const cases: [Response, string, string][] = [
      [json(500, { code: 'INTERNAL' }), 'UNKNOWN', 'http.500'],
      [json(429, {}), 'RATE_LIMITED', 'http.429'],
      [json(401, { code: 'INVALID_API_KEY' }), 'REFUSED', 'INVALID_API_KEY'],
      [json(403, {}), 'REFUSED', 'http.403'],
      [
        json(400, { code: 'AMOUNT_MINIMAL_ERROR', message: `bad ${API_KEY}` }),
        'REFUSED',
        'AMOUNT_MINIMAL_ERROR',
      ],
      [json(400, { message: 'no code' }), 'UNKNOWN', 'http.400'],
      [
        json(200, { id: INVOICE_ID, order_id: 'NPOTHERORDER0000000', invoice_url: 'https://x.io' }),
        'UNKNOWN',
        'nexa.order_id_mismatch',
      ],
      [json(200, { order_id: ORDER_ID }), 'UNKNOWN', 'http.200.unexpected_body:id'],
      [new Response('<html>502</html>', { status: 200 }), 'UNKNOWN', 'http.200.unreadable.html'],
    ];
    for (const [response, kind, code] of cases) {
      const { adapter } = adapterWith(() => response);
      const outcome = await adapter.createInvoice(API_KEY, request);
      expect(outcome.kind).toBe(kind);
      expect('code' in outcome ? outcome.code : null).toBe(code);
      expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    }
    const { adapter: refused } = adapterWith(() => json(401, { code: 'INVALID_API_KEY' }));
    expect(await refused.createInvoice(API_KEY, request)).toMatchObject({ configuration: true });
  });

  it('keeps no link that is not https', async () => {
    const { adapter } = adapterWith(() =>
      json(200, { id: INVOICE_ID, order_id: ORDER_ID, invoice_url: 'http://nowpayments.io/x' }),
    );
    const outcome = await adapter.createInvoice(API_KEY, request);
    expect(outcome.kind === 'CREATED' && outcome.invoiceUrl).toBeNull();
  });

  it('generates a twenty-character NP order id', () => {
    const id = nowpaymentsOrderId(new Uint8Array(NOWPAYMENTS_ORDER_ID_RANDOM_BYTES).fill(0));
    expect(id).toHaveLength(20);
    expect(id.startsWith('NP')).toBe(true);
    expect(new NowPaymentsAdapter().newOrderId()).toMatch(/^NP[0-9A-Z]{18}$/u);
  });
});

describe('the authoritative read', () => {
  it('reads the payment a verified webhook named, by id, with the key', async () => {
    const { adapter, calls } = adapterWith(() => json(200, PAYMENT));
    const outcome = await adapter.inquire(
      API_KEY,
      INVOICE_ID,
      context({ hintedPaymentId: '5077125051' }),
    );
    expect(calls[0]?.url).toBe(`${NOWPAYMENTS_BASE_URL}/v1/payment/5077125051`);
    expect(calls[0]?.init.method).toBe('GET');
    expect(outcome).toEqual({
      kind: 'OBSERVED',
      invoiceId: INVOICE_ID,
      orderId: ORDER_ID,
      status: 'finished',
      paid: true,
      verdict: 'APPROVED',
      requestAmount: 1234n,
      finalAmount: null,
      providerPaymentId: '5077125051',
      fundsDetected: true,
    });
  });

  it('reads ONLY the hinted payment when it is decisive (finished for the price)', async () => {
    const { adapter, calls } = adapterWith(() => json(200, PAYMENT));
    await adapter.inquire(API_KEY, INVOICE_ID, context({ hintedPaymentId: '5077125051' }));
    expect(calls).toHaveLength(1);
  });

  it('Codex #141: a hinted payment that is not decisive never hides another one under the invoice', async () => {
    // The hinted payment expired; the customer paid with another coin and that IPN was lost.
    const { adapter, calls } = adapterWith((call) =>
      call.url.includes('/v1/payment/?')
        ? json(200, {
            data: [
              { ...PAYMENT, payment_id: 2, payment_status: 'finished' },
              { ...PAYMENT, payment_id: 1, payment_status: 'expired' },
            ],
          })
        : json(200, { ...PAYMENT, payment_id: 1, payment_status: 'expired' }),
    );
    const outcome = await adapter.inquire(API_KEY, INVOICE_ID, context({ hintedPaymentId: '1' }));
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1/payment/1',
      '/v1/payment/',
    ]);
    expect(outcome).toMatchObject({ verdict: 'APPROVED', providerPaymentId: '2', paid: true });
  });

  it('keeps the hinted read as the answer when the list is refused, and ignores a hinted record of another invoice', async () => {
    const refused = adapterWith((call) =>
      call.url.includes('/v1/payment/?')
        ? json(401, { code: 'AUTH_REQUIRED' })
        : json(200, { ...PAYMENT, payment_status: 'confirming' }),
    );
    expect(
      await refused.adapter.inquire(
        API_KEY,
        INVOICE_ID,
        context({ hintedPaymentId: '5077125051' }),
      ),
    ).toMatchObject({ kind: 'OBSERVED', status: 'confirming', fundsDetected: true });

    const foreign = adapterWith((call) =>
      call.url.includes('/v1/payment/?')
        ? json(200, { data: [{ ...PAYMENT, payment_id: 3, payment_status: 'waiting' }] })
        : json(200, { ...PAYMENT, invoice_id: 999, payment_status: 'finished' }),
    );
    expect(
      await foreign.adapter.inquire(
        API_KEY,
        INVOICE_ID,
        context({ hintedPaymentId: '5077125051' }),
      ),
    ).toMatchObject({ kind: 'OBSERVED', status: 'waiting', providerPaymentId: '3' });
  });

  it('ranks statuses so a weaker webhook never displaces a stronger hint', () => {
    const adapter = new NowPaymentsAdapter();
    const ranks = ['finished', 'partially_paid', 'confirming', 'waiting', 'expired', null].map(
      (status) => adapter.hintRank(status),
    );
    expect(ranks).toEqual([4, 3, 2, 1, 0, 0]);
  });

  it('never puts a non-numeric hint in a path: it lists the invoice instead', async () => {
    const { adapter, calls } = adapterWith(() => json(200, { data: [] }));
    const outcome = await adapter.inquire(
      API_KEY,
      INVOICE_ID,
      context({ hintedPaymentId: '../x' }),
    );
    expect(calls[0]?.url).toBe(
      `${NOWPAYMENTS_BASE_URL}/v1/payment/?invoiceId=${INVOICE_ID}&limit=100&page=0&sortBy=created_at&orderBy=desc`,
    );
    expect(outcome).toEqual({ kind: 'NOT_FOUND', code: 'nowpayments.no_payment_yet' });
  });

  it('lists the invoice’s payments, ignores another invoice’s or order’s, and reports the strongest', async () => {
    const { adapter } = adapterWith(() =>
      json(200, {
        data: [
          { ...PAYMENT, payment_id: 1, payment_status: 'expired' },
          { ...PAYMENT, payment_id: 2, payment_status: 'confirming' },
          { ...PAYMENT, payment_id: 3, payment_status: 'finished', invoice_id: 999 },
          {
            ...PAYMENT,
            payment_id: 4,
            payment_status: 'finished',
            order_id: 'NPSOMEBODYELSE00000',
          },
          { not: 'a payment' },
        ],
      }),
    );
    const outcome = await adapter.inquire(API_KEY, INVOICE_ID, context());
    expect(outcome).toMatchObject({
      kind: 'OBSERVED',
      status: 'confirming',
      verdict: 'OPEN',
      paid: false,
      fundsDetected: true,
      providerPaymentId: '2',
    });
  });

  it('reports a partial payment as a MISMATCH, never paid', async () => {
    const { adapter } = adapterWith(() =>
      json(200, { ...PAYMENT, payment_status: 'partially_paid' }),
    );
    const outcome = await adapter.inquire(
      API_KEY,
      INVOICE_ID,
      context({ hintedPaymentId: '5077125051' }),
    );
    expect(outcome).toMatchObject({ kind: 'OBSERVED', verdict: 'MISMATCH', paid: false });
  });

  it('a refused key on the payment read is configuration; on the LIST it is not (it may need a JWT)', async () => {
    const read = adapterWith(() => json(401, { code: 'INVALID_API_KEY' }));
    expect(
      await read.adapter.inquire(API_KEY, INVOICE_ID, context({ hintedPaymentId: '1' })),
    ).toEqual({
      kind: 'CONFIGURATION',
      code: 'INVALID_API_KEY',
    });
    const list = adapterWith(() => json(401, { code: 'AUTH_REQUIRED' }));
    expect(await list.adapter.inquire(API_KEY, INVOICE_ID, context())).toEqual({
      kind: 'FAILED',
      code: 'nowpayments.list_refused.401',
    });
  });

  it('a 429 is a rate limit, a 5xx or timeout is a transient failure, never an answer', async () => {
    expect(
      await adapterWith(() => json(429, {})).adapter.inquire(API_KEY, INVOICE_ID, context()),
    ).toEqual({
      kind: 'RATE_LIMITED',
      code: 'http.429',
    });
    expect(
      await adapterWith(() => json(503, {})).adapter.inquire(API_KEY, INVOICE_ID, context()),
    ).toEqual({
      kind: 'FAILED',
      code: 'http.503',
    });
    const slow = new NowPaymentsAdapter({
      timeoutMs: 5,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    });
    expect(await slow.inquire(API_KEY, INVOICE_ID, context())).toEqual({
      kind: 'FAILED',
      code: 'http.timeout',
    });
  });
});

describe('the webhook, after verification', () => {
  const adapter = new NowPaymentsAdapter();

  it('names the order, the invoice and the payment, and deduplicates by payment, status and update time', () => {
    const hint = adapter.parseWebhook(PAYMENT, undefined);
    expect(hint).toEqual({
      orderId: ORDER_ID,
      invoiceId: INVOICE_ID,
      status: 'finished',
      deliveryId: `5077125051:finished:${PAYMENT.updated_at}`,
      creditAmount: null,
      paymentId: '5077125051',
    });
    expect(adapter.parseWebhook({ ...PAYMENT, invoice_id: null }, undefined)).toBeNull();
    expect(adapter.parseWebhook({ ...PAYMENT, order_id: undefined }, undefined)).toBeNull();
  });

  it('verifies through the adapter with the signature header the route reads', () => {
    expect(NOWPAYMENTS_SIGNATURE_HEADER).toBe('x-nowpayments-sig');
    expect(adapter.verifyWebhook(IPN_SECRET, PAYMENT, sign(PAYMENT))).toBe(true);
    expect(adapter.verifyWebhook(IPN_SECRET, PAYMENT, sign(PAYMENT, 'wrong'))).toBe(false);
  });
});

describe('the credential check', () => {
  it('is one read-only GET with the key, classified, with the key in no outcome', async () => {
    const ok = adapterWith(() => json(200, { estimated_amount: 0.0001 }));
    expect(await ok.adapter.checkCredential(API_KEY)).toEqual({ kind: 'OK' });
    expect(ok.calls[0]?.init.method).toBe('GET');
    expect(ok.calls[0]?.url).toBe(
      `${NOWPAYMENTS_BASE_URL}/v1/estimate?amount=10&currency_from=usd&currency_to=btc`,
    );
    const refused = adapterWith(() => json(403, { code: 'INVALID_API_KEY', message: API_KEY }));
    const outcome = await refused.adapter.checkCredential(API_KEY);
    expect(outcome).toEqual({ kind: 'REFUSED', code: 'INVALID_API_KEY' });
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    expect(await adapterWith(() => json(502, {})).adapter.checkCredential(API_KEY)).toEqual({
      kind: 'UNAVAILABLE',
      code: 'http.502',
    });
  });
});

describe('reconciliation evidence, per provider vocabulary', () => {
  it('lets an operator confirm NOWPayments only on a recorded, paid finished; fail on the rest', () => {
    const np = (to: 'CONFIRMED' | 'FAILED', status: string | null, paid: boolean | null) =>
      reconciliationEvidenceAllows('NOWPAYMENTS', to, { status, paid });
    expect(np('CONFIRMED', 'finished', true)).toBe(true);
    expect(np('CONFIRMED', 'finished', false)).toBe(false);
    expect(np('CONFIRMED', 'partially_paid', false)).toBe(false);
    expect(np('CONFIRMED', 'confirming', false)).toBe(false);
    for (const status of ['failed', 'expired', 'refunded', 'partially_paid']) {
      expect(np('FAILED', status, false)).toBe(true);
    }
    // A finished for another price (recorded unpaid) may be failed; a paid one may not.
    expect(np('FAILED', 'finished', false)).toBe(true);
    expect(np('FAILED', 'finished', true)).toBe(false);
    expect(np('FAILED', 'waiting', false)).toBe(false);
    expect(np('FAILED', null, null)).toBe(false);
  });

  it('keeps TonPays exactly as it was', () => {
    for (const provider of ['TONPAYS', 'TONPAYS_TELEGRAM'] as const) {
      const tp = (to: 'CONFIRMED' | 'FAILED', status: string, paid: boolean | null) =>
        reconciliationEvidenceAllows(provider, to, { status, paid });
      expect(tp('CONFIRMED', 'completed', true)).toBe(true);
      expect(tp('CONFIRMED', 'completed', false)).toBe(false);
      expect(tp('FAILED', 'completed', false)).toBe(false);
      expect(tp('FAILED', 'rejected', null)).toBe(true);
      expect(tp('FAILED', 'expired', null)).toBe(true);
      expect(tp('FAILED', 'canceled', null)).toBe(true);
      expect(tp('FAILED', 'finished', false)).toBe(false);
    }
  });
});
