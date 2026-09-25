import { describe, expect, it } from 'vitest';
import {
  TONPAYS_ATTEMPT_LIFETIME_MINUTES,
  TONPAYS_BASE_URL,
  TONPAYS_CALL_BUDGET_PER_MINUTE,
  TONPAYS_DOCUMENTED_REQUESTS_PER_MINUTE,
  TONPAYS_ERROR_CODES,
  TONPAYS_INQUIRY_BUDGET_PER_MINUTE,
  TONPAYS_ORDER_ID_MAX_LENGTH,
  TONPAYS_STATUSES,
  money,
} from '@nexa/contracts';
import {
  TonPaysAdapter,
  type FetchLike,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  classifyTonPaysError,
  inquiryBackoffMs,
  tomanAmountOf,
  tonpaysOrderId,
  tonpaysVerdict,
  TONPAYS_ORDER_ID_RANDOM_BYTES,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays';

/**
 * WP11A — the TonPays adapter and its pure rules (`docs/tonpays-gateway-audit.md`).
 *
 * Every request here goes to a recording fake `fetch`: nothing leaves the process. The
 * adapter is checked against the DOCUMENTED shapes only — request fields, the
 * `X-API-Key` header, the `{ detail: { code } }` error format — and against what an
 * honest client must conclude when the provider says nothing readable.
 */

const API_KEY = 'tp_live_SECRET_do_not_leak_9f2c1a';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
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
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      };
      calls.push(call);
      return answer(call);
    },
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const CREATED = {
  invoice_id: 'TP-ABC123XYZ0',
  order_id: 'NXAAAAAAAAAAAAAAAAAA',
  request_amount: 50000,
  final_amount: 50037,
  status: 'pending',
  invoice_url: 'https://t.me/TonPaysInvoiceBot?start=inv_TP-ABC123XYZ0',
  web_invoice_url: 'https://pay.tonpays.online/i/TP-ABC123XYZ0?p=xxxxx',
  callback_url: 'https://bot.example.com/payments/webhook/tonpays/t',
};

const request = (overrides: Partial<Parameters<TonPaysAdapter['createInvoice']>[1]> = {}) => ({
  orderId: 'NXAAAAAAAAAAAAAAAAAA',
  amount: 50000n,
  callbackUrl: 'https://bot.example.com/payments/webhook/tonpays/t',
  buyerChatId: '123456789',
  ...overrides,
});

/** Everything an outcome could carry, flattened, so a leak anywhere is one assertion. */
function serialised(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
}

describe('the TonPays create request', () => {
  it('posts the documented fields to the documented URL with the key in X-API-Key only', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, CREATED));
    const adapter = new TonPaysAdapter({ fetch });
    await adapter.createInvoice(API_KEY, request());

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call!.url).toBe(`${TONPAYS_BASE_URL}/api/v1/invoices/create`);
    expect(call!.init.method).toBe('POST');
    expect((call!.init.headers as Record<string, string>)['X-API-Key']).toBe(API_KEY);
    expect(call!.init.redirect).toBe('error');
    expect(call!.body).toEqual({
      amount: 50000,
      order_id: 'NXAAAAAAAAAAAAAAAAAA',
      callback_url: 'https://bot.example.com/payments/webhook/tonpays/t',
      buyer_chat_id: 123456789,
    });
    // The key is in the header and nowhere else: not the URL, not the body.
    expect(call!.url).not.toContain(API_KEY);
    expect(String(call!.init.body)).not.toContain(API_KEY);
  });

  it('sends buyer_chat_id when the Telegram id is known and OMITS it when it is not', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, CREATED));
    const adapter = new TonPaysAdapter({ fetch });
    await adapter.createInvoice(API_KEY, request({ buyerChatId: '42' }));
    await adapter.createInvoice(API_KEY, request({ buyerChatId: null }));
    expect(calls[0]!.body.buyer_chat_id).toBe(42);
    expect('buyer_chat_id' in calls[1]!.body).toBe(false);
  });

  it('omits callback_url when the installation has no public origin, rather than sending it empty', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, CREATED));
    await new TonPaysAdapter({ fetch }).createInvoice(API_KEY, request({ callbackUrl: null }));
    expect('callback_url' in calls[0]!.body).toBe(false);
  });

  it('returns both links, and never fabricates web_invoice_url when the provider did not return it', async () => {
    const both = await new TonPaysAdapter({
      fetch: fakeFetch(() => json(201, CREATED)).fetch,
    }).createInvoice(API_KEY, request());
    expect(both).toMatchObject({
      kind: 'CREATED',
      invoiceId: 'TP-ABC123XYZ0',
      webInvoiceUrl: CREATED.web_invoice_url,
      invoiceUrl: CREATED.invoice_url,
      requestAmount: 50000n,
      finalAmount: 50037n,
    });

    const { web_invoice_url: _omitted, ...withoutWeb } = CREATED;
    const telegramOnly = await new TonPaysAdapter({
      fetch: fakeFetch(() => json(201, withoutWeb)).fetch,
    }).createInvoice(API_KEY, request({ buyerChatId: null }));
    expect(telegramOnly).toMatchObject({ kind: 'CREATED', webInvoiceUrl: null });
    expect(telegramOnly.kind === 'CREATED' && telegramOnly.invoiceUrl).toBe(CREATED.invoice_url);
  });

  it('refuses a link that is not https rather than handing it to a customer', async () => {
    const outcome = await new TonPaysAdapter({
      fetch: fakeFetch(() =>
        json(201, { ...CREATED, web_invoice_url: 'javascript:alert(1)', invoice_url: 'http://x' }),
      ).fetch,
    }).createInvoice(API_KEY, request());
    expect(outcome).toMatchObject({ kind: 'CREATED', webInvoiceUrl: null, invoiceUrl: null });
  });

  it('treats a create answer for ANOTHER order id as unknown, never as this invoice', async () => {
    const outcome = await new TonPaysAdapter({
      fetch: fakeFetch(() => json(201, { ...CREATED, order_id: 'SOMEONE-ELSE' })).fetch,
    }).createInvoice(API_KEY, request());
    expect(outcome.kind).toBe('UNKNOWN');
  });
});

describe('what a create outcome may conclude', () => {
  const create = async (answer: () => Response | Promise<Response>) =>
    new TonPaysAdapter({ fetch: fakeFetch(answer).fetch, timeoutMs: 50 }).createInvoice(
      API_KEY,
      request(),
    );

  it('calls a timeout, a network error, a 5xx and an unreadable 2xx UNKNOWN — the invoice may exist', async () => {
    const never = () => new Promise<Response>(() => undefined);
    // The fake honours the abort signal the adapter passes.
    const timeout = await new TonPaysAdapter({
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          void never();
        }),
    }).createInvoice(API_KEY, request());
    expect(timeout).toMatchObject({ kind: 'UNKNOWN', code: 'http.timeout' });

    expect(
      await create(() => {
        throw new Error(`ECONNRESET ${API_KEY}`);
      }),
    ).toMatchObject({ kind: 'UNKNOWN', code: 'http.network' });
    expect(await create(() => json(502, { oops: true }))).toMatchObject({ kind: 'UNKNOWN' });
    expect(await create(() => new Response('<html>', { status: 201 }))).toMatchObject({
      kind: 'UNKNOWN',
    });
    // A 429 with no readable code says nothing documented.
    expect(await create(() => new Response('slow down', { status: 429 }))).toMatchObject({
      kind: 'UNKNOWN',
    });
  });

  it('keeps the merchant configuration codes apart from the customer invoice codes', async () => {
    for (const code of [
      'MISSING_API_KEY',
      'INVALID_API_KEY',
      'INACTIVE_API_KEY',
      'ACCOUNT_NOT_VERIFIED',
      'ACCOUNT_SUSPENDED',
      'STORE_INACTIVE',
      'ACCESS_DENIED',
      'INVALID_CALLBACK_URL',
    ]) {
      expect(await create(() => json(401, { detail: { code, message: 'x' } }))).toEqual({
        kind: 'REFUSED',
        code,
        configuration: true,
      });
    }
    for (const code of ['AMOUNT_TOO_LOW', 'AMOUNT_TOO_HIGH', 'INVALID_BUYER_CHAT_ID']) {
      expect(await create(() => json(400, { detail: { code, message: 'x' } }))).toEqual({
        kind: 'REFUSED',
        code,
        configuration: false,
      });
    }
  });

  it('reports RATE_LIMIT_EXCEEDED as rate-limited and DUPLICATE_ORDER_ID as ambiguous, never as a success', async () => {
    expect(
      await create(() => json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED', message: 'x' } })),
    ).toEqual({ kind: 'RATE_LIMITED', code: 'RATE_LIMIT_EXCEEDED' });
    expect(
      await create(() => json(409, { detail: { code: 'DUPLICATE_ORDER_ID', message: 'x' } })),
    ).toEqual({ kind: 'AMBIGUOUS', code: 'DUPLICATE_ORDER_ID' });
  });

  it('never carries the API key in any outcome, whatever the provider or the network says', async () => {
    const answers: (() => Response | Promise<Response>)[] = [
      () => json(201, CREATED),
      () => json(401, { detail: { code: 'INVALID_API_KEY', message: `bad key ${API_KEY}` } }),
      () => json(500, { detail: { code: 'X', message: API_KEY } }),
      () => {
        throw new Error(API_KEY);
      },
    ];
    for (const answer of answers) {
      expect(serialised(await create(answer))).not.toContain(API_KEY);
    }
  });
});

describe('the TonPays inquiry', () => {
  const inquire = async (body: unknown, status = 200) => {
    const { fetch, calls } = fakeFetch(() => json(status, body));
    const outcome = await new TonPaysAdapter({ fetch }).inquire(API_KEY, 'TP-ABC123XYZ0');
    return { outcome, calls };
  };

  it('uses the documented POST check form, with the invoice id in the body and the key in the header', async () => {
    const { calls } = await inquire({
      invoice_id: 'TP-ABC123XYZ0',
      order_id: 'NX1',
      status: 'pending',
      paid: false,
    });
    expect(calls[0]!.url).toBe(`${TONPAYS_BASE_URL}/api/v1/invoices/check`);
    expect(calls[0]!.body).toEqual({ invoice_id: 'TP-ABC123XYZ0' });
    expect((calls[0]!.init.headers as Record<string, string>)['X-API-Key']).toBe(API_KEY);
  });

  it('approves ONLY completed with paid === true', async () => {
    const base = {
      invoice_id: 'TP-ABC123XYZ0',
      order_id: 'NX1',
      request_amount: 1,
      final_amount: 1,
    };
    expect((await inquire({ ...base, status: 'completed', paid: true })).outcome).toMatchObject({
      kind: 'OBSERVED',
      verdict: 'APPROVED',
    });
    for (const paid of [false, 'true', 1, null, undefined]) {
      expect(
        (await inquire({ ...base, status: 'completed', paid })).outcome,
        `paid=${String(paid)}`,
      ).toMatchObject({ kind: 'OBSERVED', verdict: 'OPEN' });
    }
  });

  it('keeps INVOICE_NOT_FOUND, a rate limit and a configuration error apart, none of them a verdict', async () => {
    expect(
      (await inquire({ detail: { code: 'INVOICE_NOT_FOUND', message: 'x' } }, 404)).outcome,
    ).toEqual({ kind: 'NOT_FOUND', code: 'INVOICE_NOT_FOUND' });
    expect(
      (await inquire({ detail: { code: 'RATE_LIMIT_EXCEEDED', message: 'x' } }, 429)).outcome,
    ).toEqual({ kind: 'RATE_LIMITED', code: 'RATE_LIMIT_EXCEEDED' });
    expect(
      (await inquire({ detail: { code: 'INVALID_API_KEY', message: 'x' } }, 401)).outcome,
    ).toEqual({ kind: 'CONFIGURATION', code: 'INVALID_API_KEY' });
    expect((await inquire({ nonsense: true })).outcome.kind).toBe('FAILED');
  });
});

describe('the TonPays webhook body', () => {
  const adapter = new TonPaysAdapter();

  it('is read for its shape only — the ids, the status hint and the delivery id', () => {
    const hint = adapter.parseWebhook(
      {
        invoice_id: 'TP-ABC123XYZ0',
        order_id: 'NX1',
        request_amount: 50000,
        final_amount: 50037,
        credit_amount: 50037,
        status: 'completed',
        paid: true,
        delivery_id: 'TP-ABC123XYZ0:completed:1727200000',
        event: 'invoice.completed',
        occurred_at: 1727200000,
        api_version: 1,
      },
      undefined,
    );
    expect(hint).toEqual({
      orderId: 'NX1',
      invoiceId: 'TP-ABC123XYZ0',
      status: 'completed',
      deliveryId: 'TP-ABC123XYZ0:completed:1727200000',
      creditAmount: 50037n,
    });
    // `paid` is not part of a hint at all: nothing downstream could act on it.
    expect(hint).not.toHaveProperty('paid');
  });

  it('prefers the X-TonPays-Delivery-Id header and refuses a body without the two ids', () => {
    expect(
      adapter.parseWebhook({ invoice_id: 'a', order_id: 'b', delivery_id: 'body' }, 'header')
        ?.deliveryId,
    ).toBe('header');
    expect(adapter.parseWebhook({ order_id: 'b' }, undefined)).toBeNull();
    expect(adapter.parseWebhook('not json', undefined)).toBeNull();
  });
});

describe('the TonPays rules', () => {
  it('maps every documented status', () => {
    const verdicts = Object.fromEntries(
      TONPAYS_STATUSES.map((status) => [status, tonpaysVerdict(status, true)]),
    );
    expect(verdicts).toEqual({
      pending: 'OPEN',
      processing: 'OPEN',
      completed: 'APPROVED',
      need_action: 'OPEN',
      rejected: 'UNSUCCESSFUL',
      expired: 'UNSUCCESSFUL',
      canceled: 'UNSUCCESSFUL',
    });
    // `paid: true` does not approve anything but `completed`, and an unknown status is open.
    expect(tonpaysVerdict('pending', true)).toBe('OPEN');
    expect(tonpaysVerdict('refunded', true)).toBe('OPEN');
  });

  it('makes a 20-character order id from random bytes, never from anything else', () => {
    const a = tonpaysOrderId(new Uint8Array(TONPAYS_ORDER_ID_RANDOM_BYTES).fill(0));
    const b = tonpaysOrderId(new Uint8Array(TONPAYS_ORDER_ID_RANDOM_BYTES).fill(255));
    expect(a).toHaveLength(TONPAYS_ORDER_ID_MAX_LENGTH);
    expect(b).toHaveLength(TONPAYS_ORDER_ID_MAX_LENGTH);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^NX[0-9A-HJKMNP-TV-Z]{18}$/u);
    const adapter = new TonPaysAdapter();
    const ids = new Set(Array.from({ length: 200 }, () => adapter.newOrderId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(TONPAYS_ORDER_ID_MAX_LENGTH);
  });

  it('invoices whole Toman only: IRT as is, IRR divided by ten when exact, nothing else', () => {
    expect(tomanAmountOf(money(50_000n, 'IRT'))).toBe(50_000n);
    expect(tomanAmountOf(money(500_000n, 'IRR'))).toBe(50_000n);
    expect(tomanAmountOf(money(500_005n, 'IRR'))).toBeNull();
    expect(tomanAmountOf(money(5n, 'USD'))).toBeNull();
  });

  it('classifies every documented error code', () => {
    const classes = Object.fromEntries(
      TONPAYS_ERROR_CODES.map((c) => [c, classifyTonPaysError(c)]),
    );
    expect(classes.RATE_LIMIT_EXCEEDED).toBe('RATE_LIMITED');
    expect(classes.DUPLICATE_ORDER_ID).toBe('AMBIGUOUS');
    expect(classes.INVOICE_NOT_FOUND).toBe('NOT_FOUND');
    expect(classes.INVALID_API_KEY).toBe('CONFIGURATION');
    expect(classes.AMOUNT_TOO_LOW).toBe('REFUSED');
  });

  it('keeps below the documented rate limit, with a floor reserved for creates, and a bounded backoff', () => {
    expect(TONPAYS_CALL_BUDGET_PER_MINUTE).toBeLessThan(TONPAYS_DOCUMENTED_REQUESTS_PER_MINUTE);
    expect(TONPAYS_INQUIRY_BUDGET_PER_MINUTE).toBeLessThan(TONPAYS_CALL_BUDGET_PER_MINUTE);
    const schedule = [0, 1, 2, 3, 4, 5, 50].map(inquiryBackoffMs);
    expect(schedule).toEqual([20_000, 40_000, 80_000, 160_000, 300_000, 300_000, 300_000]);
    expect(TONPAYS_ATTEMPT_LIFETIME_MINUTES).toBe(70);
    expect(new TonPaysAdapter().attemptLifetimeMs).toBe(70 * 60_000);
  });
});
