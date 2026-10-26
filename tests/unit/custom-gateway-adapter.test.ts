import { describe, expect, it } from 'vitest';
import {
  PAYMENT_GATEWAY_DESCRIPTORS,
  money,
  type ProviderHttpRequest,
  type ProviderHttpResult,
  type ResolvedConversion,
} from '@nexa/contracts';
import { CustomGatewayAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/custom-gateway-adapter';
import { signNexaRequest } from '../../apps/api/src/modules/commerce/payments/infrastructure/custom-gateway-signature';
import { MockCustomBridge } from '../support/mock-custom-bridge';

/**
 * The custom gateway's adapter against the reference bridge (`tests/support/mock-custom-bridge.ts`,
 * written from the protocol document) and against scripted answers for every branch of the
 * create, inquiry and ping classifiers. Nothing leaves the process.
 */

const SECRET = 'cgw_test_secret_ABCDEFGHIJKLMNOPQRSTUVWXYZ_0123';
const NOW = new Date('2026-10-26T09:41:00Z');
const BASE = 'https://bridge.example/nexa';
const ORDER = 'cg_7Q2M8K4ZJ1W3X9R5T0V6B2N8CD';
const SAME = { policy: 'SAME_UNIT' } as ResolvedConversion;

function rig(options: { basePath?: string } = {}) {
  const bridge = new MockCustomBridge({
    secret: SECRET,
    now: () => NOW,
    basePath: options.basePath ?? '/nexa',
  });
  let seed = 0;
  const adapter = new CustomGatewayAdapter({
    http: bridge.http,
    now: () => NOW,
    random: (size) => {
      seed += 1;
      return new Uint8Array(size).fill(seed % 256);
    },
  });
  return { bridge, adapter };
}

const create = (overrides: Record<string, unknown> = {}) => ({
  orderId: ORDER,
  amount: 1_250_000n,
  callbackUrl: 'https://nexa.example/payments/webhook/custom/t',
  buyerChatId: null,
  presentation: null,
  providerUserId: '4829103375',
  endpoint: BASE,
  expiresAt: new Date('2026-10-26T10:51:00Z'),
  ...overrides,
});
const inquiry = (overrides: Record<string, unknown> = {}) => ({
  providerOrderId: ORDER,
  sentAmount: 1_250_000n,
  hintedPaymentId: null,
  endpoint: BASE,
  ...overrides,
});

describe('the descriptor and the unit', () => {
  it('is a rial, same-unit, inquiry-only link route with one credential and an operator endpoint', () => {
    expect(PAYMENT_GATEWAY_DESCRIPTORS.CUSTOM).toMatchObject({
      settlesVia: 'GATEWAY',
      requiresCredentials: true,
      approval: 'INQUIRY',
      invoiceForm: 'LINK',
      webhookSecret: false,
      webhookSignedByCredential: true,
      operatorEndpoint: true,
      inquiresByOrderId: true,
      numericIdentity: true,
    });
    const { adapter } = rig();
    expect(adapter.unit).toBe('IRR');
    expect(adapter.attemptLifetimeMs).toBe(70 * 60_000);
    expect(adapter.providerAmountOf(money(125_000n, 'IRT'), SAME)).toBe(1_250_000n);
    expect(
      adapter.providerAmountOf(money(125_000n, 'IRT'), { policy: 'FIXED_RATE' } as never),
    ).toBeNull();
    expect(adapter.newOrderId()).toMatch(/^cg_[0-9A-HJKMNP-TV-Z]{26}$/u);
    expect(adapter.newCustomerNumber()).toMatch(/^[0-9]{10}$/u);
  });
});

describe('create (§3.1)', () => {
  it('creates against the reference bridge: signed request under the base prefix, signed answer', async () => {
    const { bridge, adapter } = rig();
    const outcome = await adapter.createInvoice(SECRET, create());
    expect(outcome).toMatchObject({
      kind: 'CREATED',
      orderId: ORDER,
      invoiceUrl: expect.stringMatching(/^https:\/\/pay\.bridge\.test\/p\/brg-/u),
      requestAmount: 1_250_000n,
    });
    // The bridge verified the request against the PROTOCOL path, not `/nexa/v1/payments`.
    expect(bridge.received).toEqual([{ method: 'POST', path: '/v1/payments', verdict: 'ok' }]);
    const stored = [...bridge.payments.values()][0];
    expect(JSON.parse(stored?.requestBody ?? '{}')).toEqual({
      invoice_id: ORDER,
      amount: { value: '1250000', currency: 'IRR' },
      callback_url: 'https://nexa.example/payments/webhook/custom/t',
      expires_at: '2026-10-26T10:51:00.000Z',
      customer_ref: '4829103375',
    });
  });

  it('signs EXACTLY the bytes it sends (the client serialises the same value once)', async () => {
    const seen: ProviderHttpRequest[] = [];
    const adapter = new CustomGatewayAdapter({
      now: () => NOW,
      http: {
        send: async (_base, request): Promise<ProviderHttpResult> => {
          seen.push(request);
          return { ok: false, failure: 'UNREACHABLE', status: null };
        },
      },
    });
    await adapter.createInvoice(SECRET, create());
    const request = seen[0];
    if (request?.body?.kind !== 'json') throw new Error('no json body');
    const sent = JSON.stringify(request.body.value);
    const headers = request.headers ?? {};
    expect(headers['x-nexa-signature']).toBe(
      signNexaRequest(SECRET, {
        method: 'POST',
        path: '/v1/payments',
        timestamp: headers['x-nexa-timestamp'] ?? '',
        nonce: headers['x-nexa-nonce'] ?? '',
        body: sent,
      }),
    );
    expect(headers['idempotency-key']).toBe(ORDER);
    expect(request.effect).toBe('WRITE');
    // A relative path, so it resolves UNDER the base URL's own prefix.
    expect(request.path).toBe('v1/payments');
    // The secret never travels.
    expect(JSON.stringify(request)).not.toContain(SECRET);
  });

  it('a bridge that sees another path than the one signed refuses it 401, a configuration refusal', async () => {
    // A bridge at the ROOT behind a prefixed base: it receives `/nexa/v1/payments`, which is
    // not what Nexa signed, and answers the protocol's 401 — nothing was created.
    const { adapter } = rig({ basePath: '' });
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'REFUSED',
      code: 'custom.SIGNATURE_INVALID',
      configuration: true,
    });
  });

  it('refuses locally, sending nothing, with no endpoint, an http endpoint or no customer number', async () => {
    const { bridge, adapter } = rig();
    for (const endpoint of [null, undefined, 'http://bridge.example/nexa']) {
      expect(await adapter.createInvoice(SECRET, create({ endpoint }))).toMatchObject({
        kind: 'REFUSED',
        code: 'custom.ENDPOINT_MISSING',
        configuration: true,
      });
    }
    expect(await adapter.createInvoice(SECRET, create({ providerUserId: null }))).toMatchObject({
      kind: 'REFUSED',
      code: 'nexa.customer_number_missing',
    });
    expect(bridge.received).toEqual([]);
  });

  it('an unsigned 2xx, or one signed for another request, is UNKNOWN — it may exist and proves nothing', async () => {
    const { bridge, adapter } = rig();
    bridge.signResponses = false;
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'UNKNOWN',
      code: 'custom.UNSIGNED',
    });
    bridge.signResponses = true;
    bridge.responseSecret = 'some-other-secret-entirely-0000000000';
    expect(await adapter.createInvoice(SECRET, create({ orderId: 'cg_SECOND' }))).toMatchObject({
      kind: 'UNKNOWN',
      code: 'custom.UNSIGNED',
    });
  });

  it('an echo of another invoice id or amount is REFUSED and never shown, the reference kept', async () => {
    const { bridge, adapter } = rig();
    bridge.nextCreate = {
      kind: 'answer',
      status: 201,
      body: {
        invoice_id: ORDER,
        reference: 'brg-1',
        payment_url: 'https://pay.bridge.test/p/brg-1',
        status: 'PENDING',
        amount: { value: '1250010', currency: 'IRR' },
      },
    };
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'REFUSED',
      code: 'custom.ECHO_MISMATCH',
      configuration: true,
      providerInvoiceId: 'brg-1',
    });
  });

  it('a payment_url that is not https is refused, never shown', async () => {
    const { bridge, adapter } = rig();
    bridge.nextCreate = {
      kind: 'answer',
      status: 201,
      body: {
        invoice_id: ORDER,
        reference: 'brg-1',
        payment_url: 'http://pay.bridge.test/p/brg-1',
        status: 'PENDING',
        amount: { value: '1250000', currency: 'IRR' },
      },
    };
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'REFUSED',
      code: 'custom.LINK_REJECTED',
      providerInvoiceId: 'brg-1',
    });
  });

  it('409 INVOICE_CONFLICT is AMBIGUOUS, never refused, never re-keyed', async () => {
    const { bridge, adapter } = rig();
    await adapter.createInvoice(SECRET, create());
    // The same invoice id with another body: the bridge refuses with the protocol's 409.
    expect(await adapter.createInvoice(SECRET, create({ amount: 9_990_000n }))).toMatchObject({
      kind: 'AMBIGUOUS',
      code: 'custom.INVOICE_CONFLICT',
    });
    expect(bridge.payments.size).toBe(1);
  });

  it('429 RATE_LIMITED is the one answer that clears the stamp, and a bare 429 is UNKNOWN', async () => {
    const { bridge, adapter } = rig();
    bridge.nextCreate = {
      kind: 'answer',
      status: 429,
      body: { error: { code: 'RATE_LIMITED' } },
      headers: { 'retry-after': '7' },
    };
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'RATE_LIMITED',
      code: 'custom.RATE_LIMITED',
      retryAfterMs: 7_000,
    });
    bridge.nextCreate = { kind: 'answer', status: 429, body: 'slow down' };
    expect((await adapter.createInvoice(SECRET, create())).kind).toBe('UNKNOWN');
    bridge.nextCreate = { kind: 'answer', status: 429, body: { error: { code: 'INTERNAL' } } };
    expect((await adapter.createInvoice(SECRET, create())).kind).toBe('UNKNOWN');
  });

  it('a readable 4xx is a refusal (the bridge guarantees nothing was created); 5xx, a dropped write and an unreadable 4xx are UNKNOWN', async () => {
    const { bridge, adapter } = rig();
    bridge.nextCreate = {
      kind: 'answer',
      status: 422,
      body: { error: { code: 'AMOUNT_OUT_OF_RANGE' } },
    };
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'REFUSED',
      code: 'custom.AMOUNT_OUT_OF_RANGE',
      configuration: false,
    });
    bridge.nextCreate = { kind: 'answer', status: 403, body: { error: { code: 'NOVEL_CODE' } } };
    expect(await adapter.createInvoice(SECRET, create())).toMatchObject({
      kind: 'REFUSED',
      code: 'custom.UNKNOWN_CODE',
      configuration: true,
    });
    for (const scripted of [
      { kind: 'answer', status: 500, body: { error: { code: 'INTERNAL' } } },
      { kind: 'answer', status: 502, body: '<html>' },
      { kind: 'answer', status: 400, body: '<html>bad</html>' },
      { kind: 'drop' },
    ] as const) {
      bridge.nextCreate = scripted;
      expect((await adapter.createInvoice(SECRET, create())).kind).toBe('UNKNOWN');
    }
  });

  it('nothing sent (unreachable, blocked, TLS) is a refusal; a timeout after sending is UNKNOWN', async () => {
    const answers: ProviderHttpResult[] = [
      { ok: false, failure: 'UNREACHABLE', status: null },
      { ok: false, failure: 'BLOCKED_TARGET', status: null },
      { ok: false, failure: 'TLS_FAILED', status: null },
      { ok: false, failure: 'TIMEOUT', status: null, detail: 'CONNECTION_LOST_AFTER_SEND' },
      { ok: false, failure: 'MALFORMED_RESPONSE', status: 302 },
    ];
    const kinds: string[] = [];
    for (const answer of answers) {
      const adapter = new CustomGatewayAdapter({
        now: () => NOW,
        http: { send: async () => answer },
      });
      kinds.push((await adapter.createInvoice(SECRET, create())).kind);
    }
    expect(kinds).toEqual(['REFUSED', 'REFUSED', 'REFUSED', 'UNKNOWN', 'UNKNOWN']);
  });
});

describe('inquiry (§3.2)', () => {
  async function created() {
    const { bridge, adapter } = rig();
    const outcome = await adapter.createInvoice(SECRET, create());
    if (outcome.kind !== 'CREATED') throw new Error('not created');
    return { bridge, adapter, reference: outcome.invoiceId };
  }

  it('reads every status, and only PAID with exact figures approves', async () => {
    const { bridge, adapter, reference } = await created();
    const cases = [
      ['PENDING', null, 'OPEN'],
      ['PAID', 1_250_000n, 'APPROVED'],
      ['FAILED', null, 'UNSUCCESSFUL'],
      ['EXPIRED', null, 'UNSUCCESSFUL'],
      ['UNDERPAID', 1_000_000n, 'MISMATCH'],
      ['OVERPAID', 1_500_000n, 'MISMATCH'],
      ['PAID', 1_249_990n, 'MISMATCH'],
    ] as const;
    for (const [status, paid, verdict] of cases) {
      bridge.set(ORDER, status, paid);
      const outcome = await adapter.inquire(SECRET, reference, inquiry());
      expect(outcome, `${status} ${String(paid)}`).toMatchObject({
        kind: 'OBSERVED',
        invoiceId: reference,
        orderId: ORDER,
        status,
        verdict,
        paid: verdict === 'APPROVED',
      });
    }
  });

  it('asks by invoice id with reference null after a lost create, and hands the reference back', async () => {
    const { bridge, adapter, reference } = await created();
    bridge.set(ORDER, 'PAID', 1_250_000n);
    expect(await adapter.inquire(SECRET, ORDER, inquiry({ byOrderId: true }))).toMatchObject({
      kind: 'OBSERVED',
      invoiceId: reference,
      verdict: 'APPROVED',
    });
  });

  it('an unsigned answer is no information, never an approval', async () => {
    const { bridge, adapter, reference } = await created();
    bridge.set(ORDER, 'PAID', 1_250_000n);
    bridge.signResponses = false;
    expect(await adapter.inquire(SECRET, reference, inquiry())).toEqual({
      kind: 'FAILED',
      code: 'custom.UNSIGNED',
    });
  });

  it('classifies 404, 401, 429 and the transport', async () => {
    const { bridge, adapter, reference } = await created();
    bridge.nextInquiry = { kind: 'answer', status: 404, body: { error: { code: 'NOT_FOUND' } } };
    expect((await adapter.inquire(SECRET, reference, inquiry())).kind).toBe('NOT_FOUND');
    bridge.nextInquiry = {
      kind: 'answer',
      status: 401,
      body: { error: { code: 'SIGNATURE_INVALID' } },
    };
    expect(await adapter.inquire(SECRET, reference, inquiry())).toEqual({
      kind: 'CONFIGURATION',
      code: 'custom.SIGNATURE_INVALID',
    });
    bridge.nextInquiry = {
      kind: 'answer',
      status: 429,
      body: { error: { code: 'RATE_LIMITED' } },
      headers: { 'retry-after': '999' },
    };
    expect(await adapter.inquire(SECRET, reference, inquiry())).toEqual({
      kind: 'RATE_LIMITED',
      code: 'custom.RATE_LIMITED',
      retryAfterMs: 60_000,
    });
    bridge.nextInquiry = { kind: 'drop' };
    expect((await adapter.inquire(SECRET, reference, inquiry())).kind).toBe('FAILED');
    expect(await adapter.inquire(SECRET, reference, inquiry({ endpoint: null }))).toEqual({
      kind: 'CONFIGURATION',
      code: 'custom.ENDPOINT_MISSING',
    });
  });
});

describe('the connection test (§3.4)', () => {
  it('passes against a bridge that answers signed, this protocol, IRR', async () => {
    const { adapter } = rig();
    expect(await adapter.checkCredential(SECRET, { endpoint: BASE })).toEqual({ kind: 'OK' });
  });

  it('fails on the wrong secret, an unsigned answer, another protocol, no IRR, a skewed clock', async () => {
    const { bridge, adapter } = rig();
    expect(
      await adapter.checkCredential('wrong-secret-wrong-secret-wrong-secret', { endpoint: BASE }),
    ).toEqual({
      kind: 'REFUSED',
      code: 'custom.SIGNATURE_INVALID',
    });
    bridge.signResponses = false;
    expect(await adapter.checkCredential(SECRET, { endpoint: BASE })).toEqual({
      kind: 'REFUSED',
      code: 'custom.UNSIGNED',
    });
    bridge.signResponses = true;
    bridge.pingBody = { protocol: 'other', version: '1', currencies: ['IRR'] };
    expect((await adapter.checkCredential(SECRET, { endpoint: BASE })).kind).toBe('REFUSED');
    bridge.pingBody = { protocol: 'nexa-custom-gateway', version: '1', currencies: ['USD'] };
    expect(await adapter.checkCredential(SECRET, { endpoint: BASE })).toEqual({
      kind: 'REFUSED',
      code: 'custom.CURRENCY_UNSUPPORTED',
    });
    bridge.pingBody = {
      protocol: 'nexa-custom-gateway',
      version: '1',
      currencies: ['IRR'],
      bridge_time: '2026-10-26T09:43:00Z',
    };
    expect(await adapter.checkCredential(SECRET, { endpoint: BASE })).toEqual({
      kind: 'REFUSED',
      code: 'custom.CLOCK_SKEW',
    });
    expect(await adapter.checkCredential(SECRET, { endpoint: null })).toEqual({
      kind: 'REFUSED',
      code: 'custom.ENDPOINT_MISSING',
    });
  });
});

describe('the callback (§3.3)', () => {
  it('verifies over the raw bytes before anything is read, and parses only a protocol callback', async () => {
    const { bridge, adapter } = rig();
    await adapter.createInvoice(SECRET, create());
    const signed = bridge.callback(ORDER, { deliveryId: 'dlv-1' });
    const raw = Buffer.from(signed.body, 'utf8');
    const header = signed.headers['x-nexa-bridge-signature'];
    expect(adapter.verifyWebhook(SECRET, null, header, { rawBody: raw, now: NOW })).toBe(true);
    expect(
      adapter.verifyWebhook('other-secret-000000000000000000000', null, header, {
        rawBody: raw,
        now: NOW,
      }),
    ).toBe(false);
    expect(
      adapter.verifyWebhook(SECRET, null, header, {
        rawBody: raw,
        now: new Date(NOW.getTime() + 301_000),
      }),
    ).toBe(false);
    const body = JSON.parse(signed.body) as unknown;
    expect(adapter.parseWebhook(body, 'dlv-1')).toMatchObject({
      orderId: ORDER,
      deliveryId: 'dlv-1',
      status: 'PENDING',
      creditAmount: null,
    });
    // The header must be the body's own delivery id (the body is what is signed).
    expect(adapter.parseWebhook(body, 'dlv-other')).toBeNull();
    expect(adapter.parseWebhook(body, undefined)).toBeNull();
    expect(adapter.parseWebhook({ ...(body as object), version: '2' }, 'dlv-1')).toBeNull();
    expect(adapter.isWebhookProbe({ version: '1', event: 'test', delivery_id: 'x' })).toBe(true);
    expect(adapter.isWebhookProbe(body)).toBe(false);
  });
});
