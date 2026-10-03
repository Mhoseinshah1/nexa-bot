import { describe, expect, it } from 'vitest';
import {
  CENTRALPAY_BASE_URL,
  CENTRALPAY_GET_LINK_PATH,
  CENTRALPAY_INTEGER_MAX,
  CENTRALPAY_INTEGER_MIN,
  CENTRALPAY_VERIFY_PATH,
  PAYMENT_GATEWAY_DESCRIPTORS,
  money,
  type ResolvedConversion,
} from '@nexa/contracts';
import { CentralPayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/centralpay-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  CENTRALPAY_INTEGER_RANDOM_BYTES,
  centralpayInteger,
  centralpayReturnUrl,
  centralpayVerdict,
  isCentralPayInteger,
  providerInteger,
  providerReference,
} from '../../apps/api/src/modules/commerce/payments/domain/centralpay';
import {
  reconciliationEvidenceAllows,
  requiresProviderReference,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-reconciliation';

/**
 * CentralPay — the adapter and the pure rules (`docs/centralpay-gateway-audit.md`). Every
 * request goes to a recording fake `fetch`; nothing leaves the process.
 */

const LINK_KEY = 'cp_link_SECRET_do_not_leak_91c3';
const VERIFY_KEY = '5f4dcc3b5aa765d61d8327deb882cf99';
const ORDER_ID = '1234567890';
const USER_ID = '1987654321';
const CARD = '6037-9911-2233-4455';
const RETURN_BASE = 'https://bot.example.com/payments/return/centralpay/tenant-1';

interface Call {
  readonly url: string;
  readonly init: RequestInit;
  readonly body: Record<string, unknown>;
}

function adapterWith(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const call = { url, init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return answer(call);
  };
  return { adapter: new CentralPayAdapter({ fetch }), calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const SAME_UNIT: ResolvedConversion = { policy: 'SAME_UNIT' };
const context = (
  overrides: Partial<{ sentAmount: bigint; providerUserId: string | null }> = {},
) => ({
  providerOrderId: ORDER_ID,
  sentAmount: 150_000n,
  hintedPaymentId: null,
  providerUserId: USER_ID,
  ...overrides,
});
const paid = (data: Record<string, unknown>) =>
  json(200, {
    success: true,
    data: {
      referenceId: 'REF-777',
      amount: 150000,
      userId: Number(USER_ID),
      userCardNumber: CARD,
      ...data,
    },
  });

function leaks(value: unknown): boolean {
  const text = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? item.toString() : item,
  );
  return (
    text.includes(LINK_KEY) ||
    text.includes(VERIFY_KEY) ||
    text.includes(CARD) ||
    text.includes('6037')
  );
}

describe('the descriptor (spec §17)', () => {
  it('is a Toman link route with a separate verify key, a browser return and integer identities', () => {
    expect(PAYMENT_GATEWAY_DESCRIPTORS.CENTRALPAY).toMatchObject({
      settlesVia: 'GATEWAY',
      requiresCredentials: true,
      invoiceCredential: 'GATEWAY_KEY',
      approval: 'INQUIRY',
      invoiceForm: 'LINK',
      providerReview: false,
      webhookSecret: false,
      verifyKey: true,
      browserReturn: true,
      numericIdentity: true,
    });
    expect(PAYMENT_GATEWAY_DESCRIPTORS.CENTRALPAY.conversion.policies).toEqual(['SAME_UNIT']);
    expect(requiresProviderReference('CENTRALPAY')).toBe(true);
    expect(requiresProviderReference('TONPAYS')).toBe(false);
  });
});

describe('exact Toman (never rounded)', () => {
  const adapter = new CentralPayAdapter();
  it('sends IRT as it is and IRR only when it is a whole number of Toman', () => {
    expect(adapter.providerAmountOf(money(150_000n, 'IRT'), SAME_UNIT)).toBe(150_000n);
    expect(adapter.providerAmountOf(money(1_500_000n, 'IRR'), SAME_UNIT)).toBe(150_000n);
    // A Rial figure that is not a whole Toman is refused, never rounded.
    expect(adapter.providerAmountOf(money(1_500_005n, 'IRR'), SAME_UNIT)).toBeNull();
    expect(adapter.providerAmountOf(money(0n, 'IRT'), SAME_UNIT)).toBeNull();
    expect(adapter.providerAmountOf(money(100n, 'USD'), SAME_UNIT)).toBeNull();
  });
  it('reads a provider integer exactly, and nothing else', () => {
    expect(providerInteger(150000)).toBe(150_000n);
    expect(providerInteger('150000')).toBe(150_000n);
    for (const loose of [150000.5, -1, '150000.0', '1.5e5', '150,000', '', null, true, {}, '+5']) {
      expect(providerInteger(loose)).toBeNull();
    }
  });
});

describe('the integers CentralPay is sent', () => {
  it('draws ten-digit integers inside a signed 32-bit range', () => {
    const lowest = centralpayInteger(new Uint8Array(CENTRALPAY_INTEGER_RANDOM_BYTES));
    const highest = centralpayInteger(new Uint8Array(CENTRALPAY_INTEGER_RANDOM_BYTES).fill(255));
    for (const value of [lowest, highest]) {
      expect(isCentralPayInteger(value)).toBe(true);
      expect(BigInt(value) >= CENTRALPAY_INTEGER_MIN).toBe(true);
      expect(BigInt(value) <= CENTRALPAY_INTEGER_MAX).toBe(true);
    }
    expect(lowest).toBe(CENTRALPAY_INTEGER_MIN.toString());
    const adapter = new CentralPayAdapter();
    expect(isCentralPayInteger(adapter.newOrderId())).toBe(true);
    expect(isCentralPayInteger(adapter.newCustomerNumber())).toBe(true);
    expect(isCentralPayInteger('999999999')).toBe(false);
    expect(isCentralPayInteger('2147483648')).toBe(false);
  });
  it('puts the order id in the return URL, the only query parameter', () => {
    expect(centralpayReturnUrl(RETURN_BASE, ORDER_ID)).toBe(`${RETURN_BASE}?orderId=${ORDER_ID}`);
  });
});

describe('the verdict (only verify, with every local check, approves)', () => {
  const expected = { toman: 150_000n, userId: USER_ID };
  const ok = { success: true, amount: 150000, userId: Number(USER_ID), referenceId: 'R1' };
  it('approves only success, the exact Toman, the same user and a reference', () => {
    expect(centralpayVerdict(ok, expected)).toEqual({
      status: 'verified',
      verdict: 'APPROVED',
      reference: 'R1',
      mismatchReason: null,
    });
  });
  it('an amount that differs by one Toman is a MISMATCH, never an approval', () => {
    for (const amount of [149999, 150001, '150000.5', null, undefined]) {
      expect(centralpayVerdict({ ...ok, amount }, expected)).toMatchObject({
        verdict: 'MISMATCH',
        mismatchReason: 'PROVIDER_AMOUNT_MISMATCH',
      });
    }
  });
  it('another userId (or none) is a MISMATCH', () => {
    for (const userId of [1000000001, null, 'abc']) {
      expect(centralpayVerdict({ ...ok, userId }, expected)).toMatchObject({
        verdict: 'MISMATCH',
        mismatchReason: 'PROVIDER_USER_MISMATCH',
      });
    }
  });
  it('a success with no reference is a MISMATCH: uniqueness cannot be enforced', () => {
    expect(centralpayVerdict({ ...ok, referenceId: '' }, expected)).toMatchObject({
      verdict: 'MISMATCH',
      mismatchReason: 'PROVIDER_REFERENCE_MISSING',
    });
  });
  it('anything but the boolean true is OPEN, never a failure', () => {
    for (const success of [false]) {
      expect(centralpayVerdict({ ...ok, success }, expected)).toMatchObject({
        status: 'unverified',
        verdict: 'OPEN',
      });
    }
  });
  it('reads a reference as bounded printable text', () => {
    expect(providerReference(123456)).toBe('123456');
    expect(providerReference(' AB-1 ')).toBe('AB-1');
    expect(providerReference('a b')).toBeNull();
    expect(providerReference('x'.repeat(256))).toBeNull();
  });
});

describe('getLink', () => {
  it('posts the documented fields as integers with the LINK key in the body and nowhere else', async () => {
    const { adapter, calls } = adapterWith(() =>
      json(200, { success: true, data: { redirectUrl: 'https://pay.centralapi.org/p/abc' } }),
    );
    const outcome = await adapter.createInvoice(LINK_KEY, {
      orderId: ORDER_ID,
      amount: 150_000n,
      callbackUrl: RETURN_BASE,
      buyerChatId: '777000555',
      presentation: null,
      providerUserId: USER_ID,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${CENTRALPAY_BASE_URL}${CENTRALPAY_GET_LINK_PATH}`);
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('error');
    expect(calls[0]?.body).toEqual({
      api_key: LINK_KEY,
      type: 'deposit',
      amount: 150000,
      userId: Number(USER_ID),
      orderId: Number(ORDER_ID),
      returnUrl: `${RETURN_BASE}?orderId=${ORDER_ID}`,
    });
    // The Telegram id is never sent to CentralPay.
    expect(JSON.stringify(calls[0]?.body)).not.toContain('777000555');
    expect(calls[0]?.url).not.toContain(LINK_KEY);
    expect(outcome).toEqual({
      kind: 'CREATED',
      invoiceId: ORDER_ID,
      orderId: ORDER_ID,
      invoiceUrl: 'https://pay.centralapi.org/p/abc',
      webInvoiceUrl: null,
      status: null,
      requestAmount: null,
      finalAmount: null,
    });
  });

  it('refuses without a return URL or an identity, before any call', async () => {
    const { adapter, calls } = adapterWith(() => json(200, {}));
    const base = {
      orderId: ORDER_ID,
      amount: 150_000n,
      buyerChatId: null,
      presentation: null,
      providerUserId: USER_ID,
    };
    expect(await adapter.createInvoice(LINK_KEY, { ...base, callbackUrl: null })).toEqual({
      kind: 'REFUSED',
      code: 'nexa.no_return_url',
      configuration: true,
    });
    expect(
      await adapter.createInvoice(LINK_KEY, {
        ...base,
        callbackUrl: RETURN_BASE,
        providerUserId: null,
      }),
    ).toMatchObject({ kind: 'REFUSED', code: 'nexa.identity_unavailable' });
    expect(calls).toHaveLength(0);
  });

  it('classifies every answer without ever carrying a key', async () => {
    const cases: Array<[Response | Error, string]> = [
      [json(200, { success: false, message: `bad key ${LINK_KEY}` }), 'REFUSED'],
      [json(401, { message: LINK_KEY }), 'REFUSED'],
      [json(429, {}), 'RATE_LIMITED'],
      [json(502, {}), 'UNKNOWN'],
      [json(200, { success: true }), 'UNKNOWN'],
      [new Response('<html>', { status: 200 }), 'UNKNOWN'],
      [new Error('socket hang up'), 'UNKNOWN'],
    ];
    for (const [answer, kind] of cases) {
      const { adapter } = adapterWith(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const outcome = await adapter.createInvoice(LINK_KEY, {
        orderId: ORDER_ID,
        amount: 150_000n,
        callbackUrl: RETURN_BASE,
        buyerChatId: null,
        presentation: null,
        providerUserId: USER_ID,
      });
      expect(outcome.kind).toBe(kind);
      expect(leaks(outcome)).toBe(false);
    }
  });

  it('keeps no link that is not https', async () => {
    const { adapter } = adapterWith(() =>
      json(200, { success: true, data: { redirectUrl: 'http://pay.example/p' } }),
    );
    const outcome = await adapter.createInvoice(LINK_KEY, {
      orderId: ORDER_ID,
      amount: 1000n,
      callbackUrl: RETURN_BASE,
      buyerChatId: null,
      presentation: null,
      providerUserId: USER_ID,
    });
    expect(outcome).toMatchObject({ kind: 'CREATED', invoiceUrl: null });
  });
});

describe('verify', () => {
  it('posts the VERIFY key and the order id, and approves an exact, matching answer', async () => {
    const { adapter, calls } = adapterWith(() => paid({}));
    const outcome = await adapter.inquire(VERIFY_KEY, ORDER_ID, context());
    expect(calls[0]?.url).toBe(`${CENTRALPAY_BASE_URL}${CENTRALPAY_VERIFY_PATH}`);
    expect(calls[0]?.body).toEqual({ api_key: VERIFY_KEY, orderId: Number(ORDER_ID) });
    expect(outcome).toEqual({
      kind: 'OBSERVED',
      invoiceId: ORDER_ID,
      orderId: ORDER_ID,
      status: 'verified',
      paid: true,
      verdict: 'APPROVED',
      requestAmount: 150_000n,
      finalAmount: null,
      providerReference: 'REF-777',
      mismatchReason: null,
    });
    // The customer's card number is never read into an outcome.
    expect(leaks(outcome)).toBe(false);
  });

  it('an amount mismatch is never paid', async () => {
    const { adapter } = adapterWith(() => paid({ amount: 149999 }));
    expect(await adapter.inquire(VERIFY_KEY, ORDER_ID, context())).toMatchObject({
      verdict: 'MISMATCH',
      paid: false,
      mismatchReason: 'PROVIDER_AMOUNT_MISMATCH',
    });
  });

  it('a userId mismatch is never paid', async () => {
    const { adapter } = adapterWith(() => paid({ userId: 1000000001 }));
    expect(await adapter.inquire(VERIFY_KEY, ORDER_ID, context())).toMatchObject({
      verdict: 'MISMATCH',
      paid: false,
      mismatchReason: 'PROVIDER_USER_MISMATCH',
    });
  });

  it('an answer naming another order is handed back as such (the lane ignores it)', async () => {
    const { adapter } = adapterWith(() => paid({ orderId: 1111111111 }));
    expect(await adapter.inquire(VERIFY_KEY, ORDER_ID, context())).toMatchObject({
      orderId: '1111111111',
    });
  });

  it('success:false is unverified and OPEN, on a 2xx or a 4xx', async () => {
    for (const status of [200, 400, 404]) {
      const { adapter } = adapterWith(() => json(status, { success: false, message: 'not paid' }));
      expect(await adapter.inquire(VERIFY_KEY, ORDER_ID, context())).toMatchObject({
        kind: 'OBSERVED',
        status: 'unverified',
        verdict: 'OPEN',
        paid: false,
      });
    }
  });

  it('a refused key is configuration, 429 a rate limit, 5xx/timeout/garbage a transient failure', async () => {
    const cases: Array<[Response | Error, string]> = [
      [json(403, {}), 'CONFIGURATION'],
      [json(429, {}), 'RATE_LIMITED'],
      [json(500, { success: true }), 'FAILED'],
      [json(200, { ok: 1 }), 'FAILED'],
      [new Response('oops', { status: 200 }), 'FAILED'],
      [new Error('ECONNRESET'), 'FAILED'],
    ];
    for (const [answer, kind] of cases) {
      const { adapter } = adapterWith(() => {
        if (answer instanceof Error) throw answer;
        return answer;
      });
      const outcome = await adapter.inquire(VERIFY_KEY, ORDER_ID, context());
      expect(outcome.kind).toBe(kind);
      expect(leaks(outcome)).toBe(false);
    }
  });

  it('never asks about an id that is not one of its integers', async () => {
    const { adapter, calls } = adapterWith(() => paid({}));
    expect(await adapter.inquire(VERIFY_KEY, '../etc', context())).toEqual({
      kind: 'FAILED',
      code: 'nexa.not_an_order_id',
    });
    expect(calls).toHaveLength(0);
  });

  it('accepts no webhook', () => {
    expect(new CentralPayAdapter().parseWebhook({ orderId: ORDER_ID }, 'x')).toBeNull();
  });
});

describe('reconciliation evidence', () => {
  it('confirms CentralPay only on a recorded, paid verified; fails an unpaid verified or unverified', () => {
    expect(
      reconciliationEvidenceAllows('CENTRALPAY', 'CONFIRMED', { status: 'verified', paid: true }),
    ).toBe(true);
    expect(
      reconciliationEvidenceAllows('CENTRALPAY', 'CONFIRMED', { status: 'verified', paid: false }),
    ).toBe(false);
    expect(
      reconciliationEvidenceAllows('CENTRALPAY', 'FAILED', { status: 'verified', paid: false }),
    ).toBe(true);
    expect(
      reconciliationEvidenceAllows('CENTRALPAY', 'FAILED', { status: 'unverified', paid: false }),
    ).toBe(true);
    expect(
      reconciliationEvidenceAllows('CENTRALPAY', 'FAILED', { status: 'verified', paid: true }),
    ).toBe(false);
  });
});
