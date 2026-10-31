import { describe, expect, it } from 'vitest';
import { TONPAYS_TELEGRAM_ERROR_CODES, type GatewayProviderRequestState } from '@nexa/contracts';
import { CATALOGUE_FA } from '@nexa/i18n';
import {
  TonPaysTelegramAdapter,
  providerFactsOf,
} from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-telegram-adapter';
import type { FetchLike } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-adapter';
import {
  buyerConflictRetryAllowed,
  cancelAvailable,
  cardChangeAvailable,
  customerMessageKeyOfError,
  maskRefundCard,
  parseRefundCardInput,
  parseRejectReasons,
  providerNeedOfStatus,
  receiptFileName,
  refundCardAvailable,
  remainderReceiptAvailable,
  rejectReasonCodes,
  sniffReceiptImage,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';
import { WIZARD_GATES } from '../../apps/api/src/surfaces/telegram/wizard-state';
import {
  cancelOutstanding,
  cancellable,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-provider-request.lane';
import type { GatewayProviderFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * Round 6 — TonPays Telegram: the pure rules and the adapter's two new calls, against the
 * provider document's own examples (pages 14-18: `TP-CG123XYZ0`, `TP-REM123XYZ0`, card
 * `6037991234567890`, holder `Ali Rezaei`). No real call: a recording fake `fetch`.
 */

const KEY = 'tpt_live_ROUND6_KEY_never_leak_91b2';

// The document's examples, verbatim (page 17).
const LESS_ANSWER = {
  invoice_id: 'TP-CG123XYZ0',
  order_id: 'CG-TG-1001',
  request_amount: 50000,
  final_amount: 50037,
  status: 'action_required_less',
  paid: false,
  buyer_username: null,
  show_change_card: false,
  change_card_cooldown_seconds: 0,
  change_card_exhausted: false,
  status_label: 'Action required: amount less',
  need_action_kind: 'less',
  remaining_amount: 12000,
  remaining_invoice_id: 'TP-REM123XYZ0',
  remaining_card_number: '6219861012345678',
  remaining_card_holder: 'Shop Card',
  remaining_receipt_received: false,
  refund_amount: null,
  reject_reasons: [],
  refund_pending: false,
};
const MORE_ANSWER = {
  ...LESS_ANSWER,
  status: 'action_required_more',
  status_label: 'Action required: amount more',
  need_action_kind: 'more',
  remaining_amount: null,
  remaining_invoice_id: null,
  remaining_card_number: null,
  remaining_card_holder: null,
  refund_amount: 15000,
  refund_pending: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function adapterWith(answer: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(answer(url, init));
  };
  return { adapter: new TonPaysTelegramAdapter({ fetch, timeoutMs: 1_000 }), calls };
}

describe('the inquiry reads what the customer owes next, from the document’s own answers', () => {
  it('action_required_less: the remainder, its card, holder, invoice id and receipt flag', () => {
    expect(providerFactsOf('action_required_less', LESS_ANSWER)).toEqual({
      need: 'LESS',
      remainingAmount: 12000n,
      remainingCardNumber: '6219861012345678',
      remainingCardHolder: 'Shop Card',
      remainingInvoiceId: 'TP-REM123XYZ0',
      remainingReceiptReceived: false,
      refundAmount: null,
      refundPending: null,
      rejectReasons: [],
    });
  });

  it('action_required_more: the refund amount and pending flag; no remainder', () => {
    expect(providerFactsOf('action_required_more', MORE_ANSWER)).toMatchObject({
      need: 'MORE',
      refundAmount: 15000n,
      refundPending: true,
      remainingAmount: null,
      remainingInvoiceId: null,
    });
  });

  it('a shape nobody documented is NO information, never a remainder or an approval', () => {
    const odd = {
      ...LESS_ANSWER,
      remaining_amount: '12k',
      remaining_invoice_id: '../../admin',
      remaining_card_number: 6219861012345678,
      remaining_receipt_received: 'yes',
    };
    expect(providerFactsOf('action_required_less', odd)).toMatchObject({
      need: 'LESS',
      remainingAmount: null,
      remainingInvoiceId: null,
      remainingCardNumber: null,
      remainingReceiptReceived: null,
    });
    // An unknown status carries no next step at all.
    expect(providerFactsOf('something_new', LESS_ANSWER)).toBeNull();
    expect(providerFactsOf('completed', { ...LESS_ANSWER, status: 'completed' })).toBeNull();
    expect(providerNeedOfStatus('need_action')).toBeNull();
  });

  it('the adapter attaches the facts to an observed answer and the verdict stays OPEN for both statuses', async () => {
    for (const body of [LESS_ANSWER, MORE_ANSWER]) {
      const { adapter, calls } = adapterWith(() => json(200, body));
      const outcome = await adapter.inquire(KEY, 'TP-CG123XYZ0');
      expect(outcome).toMatchObject({ kind: 'OBSERVED', verdict: 'OPEN', paid: false });
      expect(outcome.kind === 'OBSERVED' ? outcome.facts?.need : null).toBe(
        body.need_action_kind === 'less' ? 'LESS' : 'MORE',
      );
      expect(calls[0]!.url).toBe(
        'https://tonpays.online/api/custom/v1/invoices/check/TP-CG123XYZ0',
      );
    }
  });

  it('the refund answer’s own `completed` + `paid: true` can never be read as an approval', async () => {
    // The document's refund response (page 16) says completed / paid: true. It is the answer to
    // /refund, which the adapter reads for nothing; an INQUIRY says what the invoice is.
    const { adapter } = adapterWith(() =>
      json(200, {
        invoice_id: 'TP-CG123XYZ0',
        order_id: 'CG-TG-1001',
        status: 'completed',
        paid: true,
        refund_amount: 15000,
        refund_pending: true,
      }),
    );
    expect(
      await adapter.refundInvoice(KEY, 'TP-CG123XYZ0', {
        cardNumber: '6037991234567890',
        cardHolder: 'Ali Rezaei',
      }),
    ).toEqual({ kind: 'ACCEPTED' });
  });
});

describe('POST /{id}/cancel and POST /{id}/refund', () => {
  it('cancel: no body, the key in the header only, the id in the path', async () => {
    const { adapter, calls } = adapterWith(() => json(200, { status: 'canceled' }));
    expect(await adapter.cancelInvoice(KEY, 'TP-CG123XYZ0')).toEqual({ kind: 'CANCELLED' });
    expect(calls[0]!.url).toBe('https://tonpays.online/api/custom/v1/invoices/TP-CG123XYZ0/cancel');
    expect(calls[0]!.init.method).toBe('POST');
    expect(calls[0]!.init.body ?? null).toBeNull();
    expect(JSON.stringify(calls[0]!.init)).not.toContain('card');
  });

  it('refund: exactly invoice_id, card_number and card_holder — no amount', async () => {
    const { adapter, calls } = adapterWith(() => json(200, { refund_pending: true }));
    await adapter.refundInvoice(KEY, 'TP-CG123XYZ0', {
      cardNumber: '6037991234567890',
      cardHolder: 'Ali Rezaei',
    });
    expect(calls[0]!.url).toBe('https://tonpays.online/api/custom/v1/invoices/TP-CG123XYZ0/refund');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      invoice_id: 'TP-CG123XYZ0',
      card_number: '6037991234567890',
      card_holder: 'Ali Rezaei',
    });
  });

  it('an unsafe invoice id is never put in a path', async () => {
    const { adapter, calls } = adapterWith(() => json(200, {}));
    expect(await adapter.cancelInvoice(KEY, '../x')).toMatchObject({ kind: 'REFUSED' });
    expect(
      await adapter.refundInvoice(KEY, 'a/b', {
        cardNumber: '6037991234567890',
        cardHolder: 'Ali',
      }),
    ).toMatchObject({ kind: 'REFUSED' });
    expect(calls).toHaveLength(0);
  });

  it('every documented refusal is a REFUSED with its code; a 5xx, a timeout and an unreadable 2xx are UNKNOWN; RATE_LIMIT_EXCEEDED is the only retryable one', async () => {
    for (const code of TONPAYS_TELEGRAM_ERROR_CODES) {
      if (code === 'RATE_LIMIT_EXCEEDED' || code === 'INVOICE_NOT_FOUND') continue;
      const { adapter } = adapterWith(() => json(409, { detail: { code, message: 'x' } }));
      const cancel = await adapter.cancelInvoice(KEY, 'TP-1');
      const refund = await adapter.refundInvoice(KEY, 'TP-1', {
        cardNumber: '6037991234567890',
        cardHolder: 'Ali',
      });
      // DUPLICATE_ORDER_ID is "ambiguous" on a create and unknown here, the write vocabulary.
      const expected = code === 'DUPLICATE_ORDER_ID' ? 'UNKNOWN' : 'REFUSED';
      expect(cancel.kind, code).toBe(expected);
      expect(refund.kind, code).toBe(expected);
      if (cancel.kind === 'REFUSED') expect(cancel.code).toBe(code);
    }
    const limited = adapterWith(() => json(429, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect((await limited.adapter.cancelInvoice(KEY, 'TP-1')).kind).toBe('RATE_LIMITED');
    // A 5xx is unknown whatever its body says: it may have cancelled.
    const broken = adapterWith(() => json(500, { detail: { code: 'RATE_LIMIT_EXCEEDED' } }));
    expect((await broken.adapter.cancelInvoice(KEY, 'TP-1')).kind).toBe('UNKNOWN');
    expect(
      (
        await broken.adapter.refundInvoice(KEY, 'TP-1', {
          cardNumber: '6037991234567890',
          cardHolder: 'Ali',
        })
      ).kind,
    ).toBe('UNKNOWN');
    const timeout = adapterWith(() => {
      throw new Error('socket hang up');
    });
    expect((await timeout.adapter.cancelInvoice(KEY, 'TP-1')).kind).toBe('UNKNOWN');
    const empty = adapterWith(() => new Response('', { status: 200 }));
    expect((await empty.adapter.cancelInvoice(KEY, 'TP-1')).kind).toBe('UNKNOWN');
    // Configuration codes are the merchant's, not the customer's.
    const config = adapterWith(() => json(403, { detail: { code: 'WRONG_API_KEY_KIND' } }));
    expect(
      await config.adapter.refundInvoice(KEY, 'TP-1', {
        cardNumber: '6037991234567890',
        cardHolder: 'Ali',
      }),
    ).toMatchObject({
      kind: 'REFUSED',
      configuration: true,
    });
  });

  it('the refund card appears in no outcome the adapter returns', async () => {
    const { adapter } = adapterWith(() =>
      json(400, { detail: { code: 'INVALID_REFUND_CARD', message: 'card 6037991234567890 bad' } }),
    );
    const outcome = await adapter.refundInvoice(KEY, 'TP-1', {
      cardNumber: '6037991234567890',
      cardHolder: 'Ali Rezaei',
    });
    expect(JSON.stringify(outcome)).not.toContain('6037991234567890');
    expect(JSON.stringify(outcome)).not.toContain('Ali Rezaei');
  });
});

describe('every documented error code has a Persian customer message', () => {
  it('maps each of the document’s codes to a template the catalogue has', () => {
    for (const code of TONPAYS_TELEGRAM_ERROR_CODES) {
      const key = customerMessageKeyOfError(code);
      expect(key, code).not.toBeNull();
      expect(CATALOGUE_FA[key!], code).toMatch(/\p{Script=Arabic}/u);
    }
    expect(customerMessageKeyOfError('NOT_A_CODE')).toBeNull();
    expect(customerMessageKeyOfError(null)).toBeNull();
  });
});

describe('receipt types', () => {
  const bytes = (...values: number[]) => new Uint8Array(values);
  const ascii = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));

  it('sniffs JPEG, PNG, WebP and GIF by magic bytes, and nothing else', () => {
    expect(sniffReceiptImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffReceiptImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe(
      'image/png',
    );
    expect(
      sniffReceiptImage(new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WEBPVP8 ')])),
    ).toBe('image/webp');
    expect(sniffReceiptImage(ascii('GIF89a......'))).toBe('image/gif');
    expect(sniffReceiptImage(ascii('GIF87a......'))).toBe('image/gif');
    // RIFF that is not WebP (a WAV), a PDF, a BMP, empty.
    expect(
      sniffReceiptImage(new Uint8Array([...ascii('RIFF'), 1, 2, 3, 4, ...ascii('WAVEfmt ')])),
    ).toBeNull();
    expect(sniffReceiptImage(ascii('%PDF-1.7'))).toBeNull();
    expect(sniffReceiptImage(ascii('BM......'))).toBeNull();
    expect(sniffReceiptImage(new Uint8Array())).toBeNull();
  });

  it('names the part by its sniffed type', () => {
    expect(receiptFileName('image/webp')).toBe('receipt.webp');
    expect(receiptFileName('image/gif')).toBe('receipt.gif');
    expect(receiptFileName('image/png')).toBe('receipt.png');
    expect(receiptFileName('image/jpeg')).toBe('receipt.jpg');
  });

  it('the adapter uploads a 10,000,000-byte WebP and refuses one byte more before any call', async () => {
    const { adapter, calls } = adapterWith(() =>
      json(200, { status: 'processing', paid: false, receipt_received: true }),
    );
    const ok = await adapter.uploadReceipt(KEY, 'TP-REM123XYZ0', {
      bytes: new Uint8Array(10_000_000),
      mimeType: 'image/webp',
      fileName: 'receipt.webp',
    });
    expect(ok.kind).toBe('ACCEPTED');
    expect(calls[0]!.url).toBe(
      'https://tonpays.online/api/custom/v1/invoices/TP-REM123XYZ0/receipt',
    );
    const big = await adapter.uploadReceipt(KEY, 'TP-1', {
      bytes: new Uint8Array(10_000_001),
      mimeType: 'image/gif',
      fileName: 'receipt.gif',
    });
    expect(big).toMatchObject({ kind: 'REFUSED', code: 'nexa.receipt_too_large' });
    expect(calls).toHaveLength(1);
  });
});

describe('the refund card, validated locally', () => {
  it('accepts the document’s own example, Persian digits, spaces and hyphens', () => {
    expect(parseRefundCardInput('6037991234567890\nAli Rezaei')).toEqual({
      cardNumber: '6037991234567890',
      cardHolder: 'Ali Rezaei',
    });
    expect(parseRefundCardInput('۶۰۳۷-۹۹۱۲ ۳۴۵۶ ۷۸۹۰\n  علی   رضایی ')).toEqual({
      cardNumber: '6037991234567890',
      cardHolder: 'علی رضایی',
    });
  });

  it('refuses anything that is not exactly a 16-digit number and a letters-only holder', () => {
    for (const bad of [
      '',
      '6037991234567890',
      '6037991234567890\n',
      '603799123456789\nAli Rezaei',
      '60379912345678900\nAli Rezaei',
      '6037x91234567890\nAli Rezaei',
      '6037991234567890\nAl',
      '6037991234567890\nAli 123',
      '6037991234567890\nAli <b>Rezaei</b>',
      '6037991234567890\nAli\nRezaei',
      `6037991234567890\n${'a'.repeat(65)}`,
    ]) {
      expect(parseRefundCardInput(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('masks to the first six and last four digits, and hides anything else whole', () => {
    expect(maskRefundCard('6037991234567890')).toBe('603799******7890');
    expect(maskRefundCard('603799')).toBe('****');
    expect(maskRefundCard('60379912345678ab')).toBe('****');
    expect(maskRefundCard('6037991234567890')).not.toContain('12345678');
  });
});

describe('reject_reasons', () => {
  it('reads strings, objects with a text field and one string; drops everything else', () => {
    expect(
      parseRejectReasons(['رسید خوانا نبود', { message: 'نام مطابقت ندارد' }, 42, null, {}]),
    ).toEqual(['رسید خوانا نبود', 'نام مطابقت ندارد']);
    expect(parseRejectReasons('one reason')).toEqual(['one reason']);
    expect(parseRejectReasons({ a: 1 })).toEqual([]);
    expect(parseRejectReasons(undefined)).toEqual([]);
  });

  it('strips control characters and markup brackets, bounds each reason and the list, and dedupes', () => {
    const many = Array.from({ length: 30 }, (_, index) => `reason ${String(index)}`);
    expect(parseRejectReasons(many)).toHaveLength(10);
    expect(parseRejectReasons(['a\u0000b\n<script>c</script>', 'a b <script>c</script>'])[0]).toBe(
      'a b script c /script',
    );
    expect(parseRejectReasons(['x'.repeat(500)])[0]).toHaveLength(200);
    expect(parseRejectReasons(['same', 'same'])).toEqual(['same']);
  });

  it('only a machine token may reach the payment history', () => {
    expect(
      rejectReasonCodes(['RECEIPT_UNREADABLE', 'low_balance', 'رسید خوانا نبود', 'two words']),
    ).toEqual(['RECEIPT_UNREADABLE', 'low_balance']);
  });
});

const created = { providerInvoiceId: 'TP-1', creationState: 'CREATED' as const };
const facts = (over: Partial<GatewayProviderFacts>): GatewayProviderFacts => ({
  need: null,
  remainingAmount: null,
  remainingCardNumber: null,
  remainingCardHolder: null,
  remainingInvoiceId: null,
  remainingReceiptReceived: null,
  refundAmount: null,
  refundPending: null,
  rejectReasons: [],
  ...over,
});
const request = (
  state: GatewayProviderRequestState,
  errorCode: string | null = null,
): { state: GatewayProviderRequestState; errorCode: string | null } => ({ state, errorCode });

describe('what the customer may do now', () => {
  it('cancel: only a pending invoice, with nothing on its way', () => {
    expect(cancelAvailable({ ...created, providerStatus: null }, null, [])).toBe(true);
    expect(cancelAvailable({ ...created, providerStatus: 'pending' }, null, [])).toBe(true);
    for (const status of [
      'processing',
      'action_required_less',
      'action_required_more',
      'completed',
      'canceled',
    ]) {
      expect(cancelAvailable({ ...created, providerStatus: status }, null, []), status).toBe(false);
    }
    expect(
      cancelAvailable({ ...created, providerStatus: 'pending' }, request('REQUESTED'), []),
    ).toBe(false);
    expect(cancelAvailable({ ...created, providerStatus: 'pending' }, request('SENT'), [])).toBe(
      false,
    );
    // R11 A8 (owner): a lost answer is not a cancellation; the customer may ask again.
    expect(cancelAvailable({ ...created, providerStatus: 'pending' }, request('UNKNOWN'), [])).toBe(
      true,
    );
    expect(cancelAvailable({ ...created, providerStatus: 'pending' }, request('REFUSED'), [])).toBe(
      true,
    );
    // A receipt on its way makes the invoice `processing`.
    for (const state of ['QUEUED', 'SENDING', 'ACCEPTED'] as const) {
      expect(
        cancelAvailable({ ...created, providerStatus: 'pending' }, null, [
          { state, inquiryResolvedAt: null },
        ]),
        state,
      ).toBe(false);
    }
    expect(
      cancelAvailable(
        { ...created, providerStatus: 'pending', creationState: 'CREATING' },
        null,
        [],
      ),
    ).toBe(false);
  });

  it('a sibling is cancelled at most once, only while pending, never with a receipt on its way', () => {
    const base = {
      paymentId: 'p' as never,
      botInstanceId: 'b',
      customerId: 'c',
      providerInvoiceId: 'TP-1',
      providerStatus: 'pending' as string | null,
      latestCancelState: null as GatewayProviderRequestState | null,
      receiptSent: false,
    };
    expect(cancellable(base)).toBe(true);
    expect(cancellable({ ...base, providerStatus: null })).toBe(true);
    for (const state of ['REQUESTED', 'SENT', 'APPLIED', 'REFUSED', 'UNKNOWN'] as const) {
      expect(cancellable({ ...base, latestCancelState: state }), state).toBe(false);
    }
    // The provider's own rate limit means "not processed": asked again.
    expect(cancellable({ ...base, latestCancelState: 'RATE_LIMITED' })).toBe(true);
    // A cancel still with the provider is the create's prerequisite.
    expect(cancelOutstanding({ ...base, latestCancelState: 'REQUESTED' })).toBe(true);
    expect(cancelOutstanding({ ...base, latestCancelState: 'SENT' })).toBe(true);
    expect(cancelOutstanding({ ...base, latestCancelState: 'RATE_LIMITED' })).toBe(false);
    expect(cancelOutstanding({ ...base, latestCancelState: null })).toBe(false);
    expect(cancellable({ ...base, receiptSent: true })).toBe(false);
    expect(cancellable({ ...base, providerStatus: 'processing' })).toBe(false);
    expect(cancellable({ ...base, providerStatus: 'action_required_more' })).toBe(false);
  });

  it('remainder receipt: only on an underpayment with a remainder invoice, not twice, not while one is on its way', () => {
    const less = facts({
      need: 'LESS',
      remainingInvoiceId: 'TP-REM1',
      remainingReceiptReceived: false,
    });
    const invoice = { ...created, providerStatus: 'action_required_less' };
    expect(remainderReceiptAvailable(invoice, less, [])).toBe(true);
    expect(
      remainderReceiptAvailable(invoice, { ...less, remainingReceiptReceived: true }, []),
    ).toBe(false);
    expect(remainderReceiptAvailable(invoice, { ...less, remainingInvoiceId: null }, [])).toBe(
      false,
    );
    expect(remainderReceiptAvailable(invoice, null, [])).toBe(false);
    expect(remainderReceiptAvailable({ ...created, providerStatus: 'pending' }, less, [])).toBe(
      false,
    );
    expect(
      remainderReceiptAvailable(invoice, less, [{ state: 'QUEUED', inquiryResolvedAt: null }]),
    ).toBe(false);
  });

  it('refund card: only on an overpayment, not while pending or in flight, and not again after a refusal that cannot change', () => {
    const more = facts({ need: 'MORE', refundPending: false });
    const invoice = { ...created, providerStatus: 'action_required_more' };
    expect(refundCardAvailable(invoice, more, null)).toBe(true);
    expect(refundCardAvailable(invoice, { ...more, refundPending: true }, null)).toBe(false);
    expect(refundCardAvailable(invoice, null, null)).toBe(false);
    expect(refundCardAvailable({ ...created, providerStatus: 'pending' }, more, null)).toBe(false);
    expect(refundCardAvailable(invoice, more, request('REQUESTED'))).toBe(false);
    expect(refundCardAvailable(invoice, more, request('SENT'))).toBe(false);
    expect(refundCardAvailable(invoice, more, request('APPLIED'))).toBe(false);
    expect(refundCardAvailable(invoice, more, request('REFUSED', 'REFUND_NOT_ALLOWED'))).toBe(
      false,
    );
    expect(refundCardAvailable(invoice, more, request('REFUSED', 'REFUND_ALREADY_OPEN'))).toBe(
      false,
    );
    // A card the provider did not accept, or a lost answer, may be entered again — explicitly.
    expect(refundCardAvailable(invoice, more, request('REFUSED', 'INVALID_REFUND_CARD'))).toBe(
      true,
    );
    expect(refundCardAvailable(invoice, more, request('REFUSED', 'INVALID_REFUND_HOLDER'))).toBe(
      true,
    );
    expect(refundCardAvailable(invoice, more, request('UNKNOWN'))).toBe(true);
    expect(refundCardAvailable(invoice, more, request('RATE_LIMITED'))).toBe(true);
  });

  it('another card for the original transfer is never offered once the invoice was under- or overpaid', () => {
    const invoice = {
      cardChangeShown: true,
      cardChangeExhausted: false,
      cardChangeCooldownUntil: null,
      cardReceivedAt: new Date('2026-10-01T00:00:00Z'),
      creationState: 'CREATED' as const,
    };
    const now = new Date('2026-10-02T00:00:00Z');
    expect(cardChangeAvailable({ ...invoice, providerStatus: 'pending' }, null, now)).toBe(true);
    expect(
      cardChangeAvailable({ ...invoice, providerStatus: 'action_required_less' }, null, now),
    ).toBe(false);
    expect(
      cardChangeAvailable({ ...invoice, providerStatus: 'action_required_more' }, null, now),
    ).toBe(false);
  });

  it('a create refused with BUYER_HAS_PENDING_INVOICE is retried once, and only that code', () => {
    expect(buyerConflictRetryAllowed('BUYER_HAS_PENDING_INVOICE', null)).toBe(true);
    expect(buyerConflictRetryAllowed('BUYER_HAS_PENDING_INVOICE', 'nexa.budget')).toBe(true);
    expect(
      buyerConflictRetryAllowed('BUYER_HAS_PENDING_INVOICE', 'BUYER_HAS_PENDING_INVOICE'),
    ).toBe(false);
    for (const code of [
      'BUYER_HAS_PROCESSING_INVOICE',
      'BUYER_HAS_NEED_ACTION_LESS',
      'BUYER_HAS_NEED_ACTION_MORE',
      'DUPLICATE_ORDER_ID',
    ]) {
      expect(buyerConflictRetryAllowed(code, null), code).toBe(false);
    }
  });
});

describe('the wizard gates of the Round 6 taps', () => {
  it('cancel (ask and confirm) and the refund card are honoured only from the card invoice; the open-invoice tap also from a notice', () => {
    for (const intent of ['GATEWAY_CANCEL_ASK', 'GATEWAY_CANCEL', 'GATEWAY_REFUND_CARD']) {
      expect(WIZARD_GATES.get(intent)?.from, intent).toEqual(['INVOICE']);
    }
    expect(WIZARD_GATES.get('GATEWAY_CHECK')?.from).toContain('NOTICE');
  });
});
