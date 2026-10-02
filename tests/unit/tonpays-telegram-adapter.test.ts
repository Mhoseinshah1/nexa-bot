import { describe, expect, it } from 'vitest';
import {
  TONPAYS_TELEGRAM_ERROR_CODES,
  TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES,
  TONPAYS_TELEGRAM_REVIEW_WINDOW_MS,
  money,
} from '@nexa/contracts';
import { TonPaysTelegramAdapter } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-telegram-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import type { GatewayReceiptOutcome } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import {
  cardChangeAvailable,
  classifyTonPaysTelegramError,
  isSafeInvoiceId,
  receiptAcknowledged,
  receiptUploadAvailable,
  reviewInquiryNextAt,
  sniffReceiptImage,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';
import { tonpaysVerdict } from '../../apps/api/src/modules/commerce/payments/domain/tonpays';
import { gatewaySettlementDeadline } from '../../apps/api/src/modules/commerce/payments/domain/settlement';

/**
 * TonPays Telegram — the adapter and its pure rules (`docs/tonpays-telegram-gateway-audit.md`).
 *
 * Every request goes to a recording fake `fetch` written from the owner's transcription of
 * the documentation: nothing leaves the process, and nothing here is evidence that the real
 * provider behaves this way (`OQ-WP10-01`, OQ-TPTG-16).
 */

const API_KEY = 'tpt_live_TELEGRAM_KEY_never_leak_7e1a';
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

function fakeFetch(answer: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike;
  calls: Call[];
} {
  const calls: Call[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, init };
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

const ORDER_ID = 'NTAAAAAAAAAAAAAAAAAA';
const CREATED = {
  invoice_id: 'TPT-1001',
  order_id: ORDER_ID,
  request_amount: 250000,
  final_amount: 250037,
  status: 'pending',
  callback_url: 'https://bot.example.com/payments/webhook/tonpays_telegram/t',
  card_number: '6037-9911-2233-4455',
  card_name: 'علی رضایی',
};

const createRequest = (buyerChatId: string | null = '910910') => ({
  orderId: ORDER_ID,
  amount: 250_000n,
  callbackUrl: 'https://bot.example.com/payments/webhook/tonpays_telegram/t',
  buyerChatId,
  presentation: null,
});

const adapterWith = (fetch: FetchLike) => new TonPaysTelegramAdapter({ fetch, timeoutMs: 1_000 });

describe('the TonPays Telegram adapter: create', () => {
  it('sends the documented request — path, header, JSON with a REQUIRED integer buyer_chat_id — and reads a card, never a link', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, CREATED));
    const outcome = await adapterWith(fetch).createInvoice(API_KEY, createRequest());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://tonpays.online/api/custom/v1/invoices/telegram/create');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.redirect).toBe('error');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['X-API-Key']).toBe(API_KEY);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      amount: 250000,
      order_id: ORDER_ID,
      buyer_chat_id: 910910,
      callback_url: 'https://bot.example.com/payments/webhook/tonpays_telegram/t',
    });
    expect(outcome).toMatchObject({
      kind: 'CREATED',
      invoiceId: 'TPT-1001',
      invoiceUrl: null,
      webInvoiceUrl: null,
      finalAmount: 250037n,
      instructions: { cardNumber: '6037-9911-2233-4455', cardName: 'علی رضایی' },
    });
    expect(
      JSON.stringify(outcome, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v)),
    ).not.toContain(API_KEY);
  });

  it('TPTG-18: refuses locally, sending nothing, when the buyer chat id is missing or not a safe integer', async () => {
    const { fetch, calls } = fakeFetch(() => json(201, CREATED));
    for (const bad of [null, 'abc', '1e9', '99999999999999999999']) {
      const outcome = await adapterWith(fetch).createInvoice(API_KEY, createRequest(bad));
      expect(outcome).toEqual({
        kind: 'REFUSED',
        code: 'nexa.buyer_chat_id_missing',
        configuration: false,
      });
    }
    expect(calls).toHaveLength(0);
  });

  it('a created answer without a card is a created invoice with no instructions (OQ-TPTG-06)', async () => {
    const { fetch } = fakeFetch(() =>
      json(201, { ...CREATED, card_number: null, card_name: null }),
    );
    const outcome = await adapterWith(fetch).createInvoice(API_KEY, createRequest());
    expect(outcome).toMatchObject({ kind: 'CREATED', instructions: null });
  });

  it('TPTG-06 (create): every 5xx is UNKNOWN whatever code its body carries; a 4xx RATE_LIMIT_EXCEEDED is RATE_LIMITED', async () => {
    for (const code of ['RATE_LIMIT_EXCEEDED', 'WRONG_API_KEY_KIND', 'DUPLICATE_ORDER_ID']) {
      const { fetch } = fakeFetch(() => json(502, { detail: { code, message: 'x' } }));
      expect(await adapterWith(fetch).createInvoice(API_KEY, createRequest())).toEqual({
        kind: 'UNKNOWN',
        code: 'http.502',
      });
    }
    const { fetch } = fakeFetch(() => json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect(await adapterWith(fetch).createInvoice(API_KEY, createRequest())).toEqual({
      kind: 'RATE_LIMITED',
      code: 'RATE_LIMIT_EXCEEDED',
    });
  });

  it('TPTG-15 / §11: classifies the nine documented codes deliberately; the merchant configuration is never the customer’s payment', async () => {
    const expected: Record<string, unknown> = {
      WRONG_API_KEY_KIND: { kind: 'REFUSED', configuration: true },
      GATEWAY_NOT_APPROVED: { kind: 'REFUSED', configuration: true },
      MISSING_API_KEY: { kind: 'REFUSED', configuration: true },
      INVALID_API_KEY: { kind: 'REFUSED', configuration: true },
      DUPLICATE_ORDER_ID: { kind: 'AMBIGUOUS' },
      INVALID_RECEIPT_TYPE: { kind: 'REFUSED', configuration: false },
      RECEIPT_TOO_LARGE: { kind: 'REFUSED', configuration: false },
      RATE_LIMIT_EXCEEDED: { kind: 'RATE_LIMITED' },
      INVOICE_NOT_FOUND: { kind: 'REFUSED', configuration: false },
    };
    expect(Object.keys(expected).sort()).toEqual([...TONPAYS_TELEGRAM_ERROR_CODES].sort());
    for (const code of TONPAYS_TELEGRAM_ERROR_CODES) {
      const { fetch } = fakeFetch(() => json(400, { detail: { code, message: 'x' } }));
      const outcome = await adapterWith(fetch).createInvoice(API_KEY, createRequest());
      expect(outcome, code).toMatchObject(expected[code] as object);
    }
    expect(classifyTonPaysTelegramError('WRONG_API_KEY_KIND')).toBe('CONFIGURATION');
    expect(classifyTonPaysTelegramError('INVALID_RECEIPT_TYPE')).toBe('RECEIPT_REFUSED');
    expect(classifyTonPaysTelegramError('RECEIPT_TOO_LARGE')).toBe('RECEIPT_REFUSED');
    expect(classifyTonPaysTelegramError('SOMETHING_NEW')).toBe('REFUSED');
  });

  it('an answer for another order is UNKNOWN, never adopted; a lost answer is UNKNOWN', async () => {
    const other = fakeFetch(() => json(201, { ...CREATED, order_id: 'NTBBBBBBBBBBBBBBBBBB' }));
    expect(await adapterWith(other.fetch).createInvoice(API_KEY, createRequest())).toEqual({
      kind: 'UNKNOWN',
      code: 'nexa.order_id_mismatch',
    });
    const lost = fakeFetch(() => {
      throw new Error('socket hang up');
    });
    expect((await adapterWith(lost.fetch).createInvoice(API_KEY, createRequest())).kind).toBe(
      'UNKNOWN',
    );
  });

  it('mints twenty-character NT order ids', () => {
    const adapter = new TonPaysTelegramAdapter();
    const id = adapter.newOrderId();
    expect(id).toMatch(/^NT[0-9A-HJKMNP-TV-Z]{18}$/u);
  });

  it('prices in Toman only', () => {
    const adapter = new TonPaysTelegramAdapter();
    expect(adapter.providerAmountOf(money(250_000n, 'IRT'), { policy: 'SAME_UNIT' })).toBe(
      250_000n,
    );
    expect(adapter.providerAmountOf(money(2_500_005n, 'IRR'), { policy: 'SAME_UNIT' })).toBeNull();
  });
});

describe('the TonPays Telegram adapter: inquiry, card change and receipt', () => {
  it('asks the inquiry with GET and the invoice id IN THE PATH, encoded', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { invoice_id: 'TPT-1001', order_id: ORDER_ID, status: 'completed', paid: true }),
    );
    const outcome = await adapterWith(fetch).inquire(API_KEY, 'TPT-1001');
    expect(calls[0]!.url).toBe('https://tonpays.online/api/custom/v1/invoices/check/TPT-1001');
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.body).toBeUndefined();
    expect(outcome).toMatchObject({ kind: 'OBSERVED', verdict: 'APPROVED', paid: true });
  });

  it('TPTG-17: an invoice id outside the safe charset is never placed in a URL path', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const adapter = adapterWith(fetch);
    for (const bad of ['../x', 'a/b', 'TPT 1', 'x?y=1', '%2e%2e', '', 'a'.repeat(65)]) {
      expect(isSafeInvoiceId(bad), bad).toBe(false);
      expect((await adapter.inquire(API_KEY, bad)).kind).toBe('FAILED');
      expect((await adapter.changeCard(API_KEY, bad)).kind).toBe('REFUSED');
      expect(
        (
          await adapter.uploadReceipt(API_KEY, bad, {
            bytes: JPEG,
            mimeType: 'image/jpeg',
            fileName: 'r.jpg',
          })
        ).kind,
      ).toBe('REFUSED');
    }
    expect(calls).toHaveLength(0);
    expect(isSafeInvoiceId('TPT_1001-a')).toBe(true);
  });

  it('a card change reads the new card and the provider’s policy; a 2xx without a card is UNKNOWN', async () => {
    const changed = fakeFetch(() =>
      json(200, {
        card_number: '5022-2910-0000-1111',
        card_name: 'مریم',
        show_change_card: true,
        change_card_cooldown_seconds: 60,
        change_card_exhausted: false,
      }),
    );
    const outcome = await adapterWith(changed.fetch).changeCard(API_KEY, 'TPT-1001');
    expect(changed.calls[0]!.url).toBe(
      'https://tonpays.online/api/custom/v1/invoices/TPT-1001/change-card',
    );
    expect(changed.calls[0]!.init.method).toBe('POST');
    expect(outcome).toEqual({
      kind: 'CHANGED',
      instructions: { cardNumber: '5022-2910-0000-1111', cardName: 'مریم' },
      policy: { showChangeCard: true, cooldownSeconds: 60, exhausted: false },
    });
    const empty = fakeFetch(() => json(200, { show_change_card: false }));
    expect((await adapterWith(empty.fetch).changeCard(API_KEY, 'TPT-1001')).kind).toBe('UNKNOWN');
  });

  it('TPTG-04/06 (change card): a 5xx is UNKNOWN even with a rate-limit code; only a 4xx rate limit is RATE_LIMITED', async () => {
    const five = fakeFetch(() => json(503, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect((await adapterWith(five.fetch).changeCard(API_KEY, 'TPT-1001')).kind).toBe('UNKNOWN');
    const four = fakeFetch(() => json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect((await adapterWith(four.fetch).changeCard(API_KEY, 'TPT-1001')).kind).toBe(
      'RATE_LIMITED',
    );
    const missing = fakeFetch(() => json(404, { detail: { code: 'INVOICE_NOT_FOUND' } }));
    expect((await adapterWith(missing.fetch).changeCard(API_KEY, 'TPT-1001')).kind).toBe(
      'NOT_FOUND',
    );
  });

  it('uploads the receipt as multipart/form-data in the field `file`, and carries the answer as metadata', async () => {
    const { fetch, calls } = fakeFetch(() =>
      json(200, { status: 'processing', paid: false, receipt_received: true }),
    );
    const outcome = await adapterWith(fetch).uploadReceipt(API_KEY, 'TPT-1001', {
      bytes: JPEG,
      mimeType: 'image/jpeg',
      fileName: 'receipt.jpg',
    });
    expect(calls[0]!.url).toBe('https://tonpays.online/api/custom/v1/invoices/TPT-1001/receipt');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['content-type']).toMatch(/^multipart\/form-data; boundary=/u);
    expect(headers['X-API-Key']).toBe(API_KEY);
    const body = Buffer.from(calls[0]!.init.body as Uint8Array).toString('latin1');
    expect(body).toContain('name="file"; filename="receipt.jpg"');
    expect(body).toContain('Content-Type: image/jpeg');
    expect(outcome).toEqual({
      kind: 'ACCEPTED',
      status: 'processing',
      paid: false,
      receiptReceived: true,
    });
  });

  it('TPTG-06 (receipt): only a 4xx RATE_LIMIT_EXCEEDED is RATE_LIMITED; a 5xx carrying it is UNKNOWN; an image refusal is marked', async () => {
    const file = { bytes: JPEG, mimeType: 'image/jpeg' as const, fileName: 'r.jpg' };
    const five = fakeFetch(() => json(500, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect(await adapterWith(five.fetch).uploadReceipt(API_KEY, 'TPT-1001', file)).toEqual({
      kind: 'UNKNOWN',
      code: 'http.500',
    });
    const four = fakeFetch(() => json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect((await adapterWith(four.fetch).uploadReceipt(API_KEY, 'TPT-1001', file)).kind).toBe(
      'RATE_LIMITED',
    );
    const noCode = fakeFetch(() => json(429, { message: 'slow down' }));
    expect((await adapterWith(noCode.fetch).uploadReceipt(API_KEY, 'TPT-1001', file)).kind).toBe(
      'UNKNOWN',
    );
    const type = fakeFetch(() => json(400, { detail: { code: 'INVALID_RECEIPT_TYPE' } }));
    expect(await adapterWith(type.fetch).uploadReceipt(API_KEY, 'TPT-1001', file)).toEqual({
      kind: 'REFUSED',
      code: 'INVALID_RECEIPT_TYPE',
      configuration: false,
      receiptRefused: true,
    });
    const wrong = fakeFetch(() => json(403, { detail: { code: 'WRONG_API_KEY_KIND' } }));
    expect(await adapterWith(wrong.fetch).uploadReceipt(API_KEY, 'TPT-1001', file)).toEqual({
      kind: 'REFUSED',
      code: 'WRONG_API_KEY_KIND',
      configuration: true,
      receiptRefused: false,
    });
  });

  it('never uploads past the documented 5 MB, and never an empty file', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    const big = new Uint8Array(TONPAYS_TELEGRAM_RECEIPT_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff]);
    for (const bytes of [big, new Uint8Array(0)]) {
      const outcome = await adapterWith(fetch).uploadReceipt(API_KEY, 'TPT-1001', {
        bytes,
        mimeType: 'image/jpeg',
        fileName: 'r.jpg',
      });
      expect(outcome.kind).toBe('REFUSED');
    }
    expect(calls).toHaveLength(0);
  });
});

describe('the TonPays Telegram rules', () => {
  it('TPTG-01/38: only an inquiry’s completed AND paid === true approves; rejected/expired/canceled fail; the rest stays open', () => {
    expect(tonpaysVerdict('completed', true)).toBe('APPROVED');
    for (const paid of [false, 'true', 1, null, undefined]) {
      expect(tonpaysVerdict('completed', paid)).toBe('OPEN');
    }
    for (const status of ['rejected', 'expired', 'canceled']) {
      expect(tonpaysVerdict(status, true)).toBe('UNSUCCESSFUL');
    }
    for (const status of ['pending', 'processing', 'need_action', 'something_new']) {
      expect(tonpaysVerdict(status, true)).toBe('OPEN');
    }
  });

  it('TPTG-29: only an ACCEPTED upload with receipt_received === true or status "processing" acknowledges', () => {
    const accepted = (status: string | null, receiptReceived: unknown, paid: unknown = false) =>
      ({ kind: 'ACCEPTED', status, receiptReceived, paid }) as GatewayReceiptOutcome;
    expect(receiptAcknowledged(accepted('processing', true))).toBe(true);
    expect(receiptAcknowledged(accepted('pending', true))).toBe(true);
    expect(receiptAcknowledged(accepted('processing', null))).toBe(true);
    const never: GatewayReceiptOutcome[] = [
      accepted('pending', false),
      accepted('pending', 'true'),
      accepted('pending', 1),
      accepted(null, null),
      accepted('PROCESSING', null),
      accepted('completed', null, true),
      accepted('need_action', false),
      { kind: 'UNKNOWN', code: 'http.timeout' },
      { kind: 'UNKNOWN', code: 'http.502' },
      { kind: 'REFUSED', code: 'INVALID_RECEIPT_TYPE', configuration: false, receiptRefused: true },
      { kind: 'RATE_LIMITED', code: 'RATE_LIMIT_EXCEEDED' },
      { kind: 'NOT_FOUND', code: 'INVOICE_NOT_FOUND' },
    ];
    for (const outcome of never)
      expect(receiptAcknowledged(outcome), JSON.stringify(outcome)).toBe(false);
  });

  it('§9.6.3 d: the settlement deadline is the review deadline once acknowledged, expires_at otherwise', () => {
    const expiresAt = new Date('2026-10-02T10:00:00Z');
    const providerReviewUntil = new Date('2026-10-03T09:30:00Z');
    expect(gatewaySettlementDeadline({ expiresAt, providerReviewUntil: null })).toBe(expiresAt);
    expect(gatewaySettlementDeadline({ expiresAt, providerReviewUntil })).toBe(providerReviewUntil);
    expect(gatewaySettlementDeadline({ expiresAt: null, providerReviewUntil: null })).toBeNull();
  });

  it('TPTG-40: the review inquiry cadence is 2 / 10 / 30 minutes, ends with one inquiry 15 s before the deadline, and stays near a hundred calls', () => {
    const start = new Date('2026-10-02T10:00:00Z');
    const until = new Date(start.getTime() + TONPAYS_TELEGRAM_REVIEW_WINDOW_MS);
    expect(reviewInquiryNextAt(start, until, start)!.getTime() - start.getTime()).toBe(120_000);
    const two = new Date(start.getTime() + 2 * 3_600_000);
    expect(reviewInquiryNextAt(start, until, two)!.getTime() - two.getTime()).toBe(600_000);
    const ten = new Date(start.getTime() + 10 * 3_600_000);
    expect(reviewInquiryNextAt(start, until, ten)!.getTime() - ten.getTime()).toBe(1_800_000);
    const late = new Date(until.getTime() - 60_000);
    expect(reviewInquiryNextAt(start, until, late)!.getTime()).toBe(until.getTime() - 15_000);
    expect(reviewInquiryNextAt(start, until, new Date(until.getTime() - 10_000))).toBeNull();
    // A step that would land INSIDE the last fifteen seconds is pulled back to them.
    const nearEnd = new Date(until.getTime() - 1_800_000 - 10_000);
    expect(reviewInquiryNextAt(start, until, nearEnd)!.getTime()).toBe(until.getTime() - 15_000);
    let calls = 1;
    let at = start;
    for (;;) {
      const next = reviewInquiryNextAt(start, until, at);
      if (next === null) break;
      expect(next.getTime()).toBeLessThan(until.getTime());
      calls += 1;
      at = next;
    }
    expect(calls).toBeGreaterThan(90);
    expect(calls).toBeLessThan(110);
    expect(at.getTime()).toBe(until.getTime() - 15_000);
  });

  it('sniffs JPEG and PNG by magic bytes only', () => {
    expect(sniffReceiptImage(JPEG)).toBe('image/jpeg');
    expect(
      sniffReceiptImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])),
    ).toBe('image/png');
    expect(sniffReceiptImage(new TextEncoder().encode('%PDF-1.7'))).toBeNull();
    expect(sniffReceiptImage(new Uint8Array(0))).toBeNull();
  });

  it('TPTG-20: a card change is refused while one is in flight, during the provider’s cooldown, once exhausted, or when the provider hides it', () => {
    const now = new Date('2026-10-02T10:10:00Z');
    const invoice = {
      creationState: 'CREATED' as const,
      cardChangeShown: true,
      cardChangeExhausted: false,
      cardChangeCooldownUntil: null,
      cardReceivedAt: new Date('2026-10-02T10:00:00Z'),
    };
    expect(cardChangeAvailable(invoice, null, now)).toBe(true);
    expect(
      cardChangeAvailable(invoice, { state: 'REQUESTED', requestedAt: now, decidedAt: null }, now),
    ).toBe(false);
    expect(
      cardChangeAvailable(invoice, { state: 'SENT', requestedAt: now, decidedAt: null }, now),
    ).toBe(false);
    expect(
      cardChangeAvailable(
        { ...invoice, cardChangeCooldownUntil: new Date(now.getTime() + 1_000) },
        null,
        now,
      ),
    ).toBe(false);
    expect(cardChangeAvailable({ ...invoice, cardChangeExhausted: true }, null, now)).toBe(false);
    expect(cardChangeAvailable({ ...invoice, cardChangeShown: false }, null, now)).toBe(false);
    // The local sixty seconds from the card last shown.
    expect(
      cardChangeAvailable(
        { ...invoice, cardReceivedAt: new Date(now.getTime() - 30_000) },
        null,
        now,
      ),
    ).toBe(false);
  });

  it('a receipt may be sent only with nothing in flight and no unresolved lost upload, while the provider still says pending', () => {
    const created = { creationState: 'CREATED' as const, providerStatus: 'pending' };
    expect(receiptUploadAvailable(created, [])).toBe(true);
    expect(receiptUploadAvailable(created, [{ state: 'QUEUED', inquiryResolvedAt: null }])).toBe(
      false,
    );
    expect(receiptUploadAvailable(created, [{ state: 'SENDING', inquiryResolvedAt: null }])).toBe(
      false,
    );
    expect(receiptUploadAvailable(created, [{ state: 'UNKNOWN', inquiryResolvedAt: null }])).toBe(
      false,
    );
    expect(
      receiptUploadAvailable(created, [{ state: 'UNKNOWN', inquiryResolvedAt: new Date() }]),
    ).toBe(true);
    expect(receiptUploadAvailable({ ...created, providerStatus: 'processing' }, [])).toBe(false);
  });
});
