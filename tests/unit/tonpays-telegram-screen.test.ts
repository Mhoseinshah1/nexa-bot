import { describe, expect, it } from 'vitest';
import { money, type PaymentId, type UserId } from '@nexa/contracts';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type {
  GatewayInvoiceRecord,
  GatewayProviderFacts,
  GatewayProviderRequestRecord,
  GatewayReceiptSubmissionRecord,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import type { GatewayCardFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * The TonPays Telegram payment screen (`docs/tonpays-telegram-gateway-audit.md` §8.1), as the
 * one pure function the turn and the worker both render through. Pinned here: which screen
 * each state draws, and which of «📤 ارسال فیش واریزی» (`gr:`) and «🔄 تعویض کارت» (`gk:`)
 * it offers — a button drawn where its rule forbids it is an invitation to pay twice.
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;
const CREATED_AT = new Date('2026-10-02T10:00:00Z');
const EXPIRES_AT = new Date('2026-10-02T11:10:00Z');

function payment(overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    id: PAYMENT_ID,
    source: 'NEXA',
    customerId: '01a0fa00-0000-7000-8000-0000000000c1' as UserId,
    orderId: '01a0fa00-0000-7000-8000-0000000000d1' as never,
    state: 'PENDING',
    method: 'GATEWAY',
    amount: money(250_000n, 'IRT'),
    reference: 'ref',
    code: null,
    evidenceKind: null,
    evidenceNote: null,
    externalReference: 'TPT-1',
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    resolutionNote: null,
    customerSignalledAt: null,
    checkoutHeldUntil: null,
    expiresAt: EXPIRES_AT,
    gatewayProvider: 'TONPAYS_TELEGRAM',
    topupCashbackPercent: null,
    customerFee: null,
    providerReviewStartedAt: null,
    providerReviewUntil: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function invoice(overrides: Partial<GatewayInvoiceRecord> = {}): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider: 'TONPAYS_TELEGRAM',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'TPT-1',
    hintedInvoiceId: null,
    hintedPaymentId: null,
    providerUserId: null,
    creationState: 'CREATED',
    creationAttempts: 1,
    creationSentAt: CREATED_AT,
    creationRetryAt: null,
    creationErrorCode: null,
    createdInvoiceAt: CREATED_AT,
    buyerChatIdSent: true,
    callbackUrlSent: true,
    invoiceUrl: null,
    webInvoiceUrl: null,
    providerUnit: 'IRT',
    sentAmount: 250_000n,
    conversionRateMinor: null,
    conversionPolicy: 'SAME_UNIT',
    fx: null,
    botInstanceId: '01900000-0000-7000-8000-00000000a001',
    providerChargeId: null,
    requestAmount: 250_000n,
    finalAmount: 250_037n,
    creditAmount: null,
    providerStatus: 'pending',
    providerPaid: false,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
    rowFailures: 0,
    inquiryAttempts: 0,
    nextInquiryAt: null,
    postDeadlineInquiries: 0,
    webhookStatusHint: null,
    lastWebhookAt: null,
    lastWebhookDeliveryId: null,
    webhookCount: 0,
    outcome: null,
    outcomeAt: null,
    lateCompletionObservedAt: null,
    cardNumber: '6037-9911-0000-1001',
    cardName: 'علی رضایی',
    cardSeq: 1,
    cardReceivedAt: CREATED_AT,
    cardChangeShown: true,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: false,
    reconcileInquiryRequestedAt: null,
    cryptoPayCurrency: null,
    cryptoRequested: null,
    cryptoPaid: null,
    cryptoReceived: null,
    cryptoReceivedCurrency: null,
    cryptoPayAddress: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

const NO_FACTS: GatewayCardFacts = {
  latestChange: null,
  submissions: [],
  providerFacts: null,
  latestCancel: null,
  latestRefund: null,
  openElsewherePaymentId: null,
};
const AT = new Date('2026-10-02T10:30:00Z');

const submission = (
  state: GatewayReceiptSubmissionRecord['state'],
): GatewayReceiptSubmissionRecord => ({
  id: 's1',
  paymentId: PAYMENT_ID,
  providerInvoiceId: 'TPT-1',
  botInstanceId: 'b',
  customerId: 'c',
  captureId: 'w',
  telegramFileId: 'f',
  telegramFileUniqueId: 'u',
  declaredSize: 10n,
  state,
  attempts: 1,
  sentAt: null,
  retryAt: null,
  decidedAt: null,
  errorCode: null,
  providerStatus: null,
  receiptReceived: null,
  openedReview: false,
  inquiryResolvedAt: null,
  byteLength: null,
  rowFailures: 0,
  createdAt: CREATED_AT,
});

const data = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
  reply.buttons.map((button) => ('data' in button ? button.data : null));

describe('the TonPays Telegram payment screen', () => {
  it('shows the card, the payable, TonPays’ own figure apart, and the three actions in the customer window', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_card_invoice');
    expect(reply.values).toMatchObject({
      cardNumber: '6037-9911-0000-1001',
      cardName: 'علی رضایی',
      payable: money(250_000n, 'IRT'),
      transferAmount: money(250_037n, 'IRT'),
      expiresAt: EXPIRES_AT,
    });
    // Round 6: «❌ لغو فاکتور» (`gq:`) is the fourth action of a pending invoice.
    expect(data(reply)).toEqual([
      `gr:${PAYMENT_ID}`,
      `gk:${PAYMENT_ID}`,
      `gq:${PAYMENT_ID}`,
      `gc:${PAYMENT_ID}`,
      'mm:',
    ]);
    expect(reply.wizard).toMatchObject({ step: 'INVOICE', paymentId: PAYMENT_ID });
  });

  it('TPTG-39: in review it renders gateway_in_review — no receipt, no card change, no retry — and never closed', () => {
    const reviewUntil = new Date(AT.getTime() + 24 * 3_600_000);
    const later = new Date(EXPIRES_AT.getTime() + 3_600_000);
    const reply = gatewayAttemptScreen(
      {
        payment: payment({ providerReviewStartedAt: AT, providerReviewUntil: reviewUntil }),
        invoice: invoice(),
      },
      'o',
      later,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_in_review');
    expect(reply.values).toMatchObject({ reviewUntil });
    expect(data(reply)).toEqual([`gc:${PAYMENT_ID}`, 'mm:']);
  });

  it('TPTG-39: UNKNOWN renders gateway_review_unresolved with the main menu only — never failed, never closed', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment({ state: 'UNKNOWN' }), invoice: invoice() },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_review_unresolved');
    expect(data(reply)).toEqual(['mm:']);
  });

  it('TPTG-19: past the customer window (no review) it is closed, and offers no receipt or card change', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice() },
      'o',
      EXPIRES_AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_closed');
    expect(data(reply).filter((one) => one?.startsWith('gr:') || one?.startsWith('gk:'))).toEqual(
      [],
    );
  });

  it('draws gk: only while the provider allows a change and none is in flight; hides a lost card', () => {
    const exhausted = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ cardChangeExhausted: true }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(data(exhausted)).not.toContain(`gk:${PAYMENT_ID}`);
    const changing = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
      latestChange: {
        id: 'c',
        paymentId: PAYMENT_ID,
        botInstanceId: 'b',
        customerId: 'c',
        state: 'SENT',
        requestedAt: AT,
        sentAt: AT,
        decidedAt: null,
        errorCode: null,
      },
      submissions: [],
    });
    expect(changing.key).toBe('bot.payment.gateway_card_changing');
    expect(data(changing)).not.toContain(`gk:${PAYMENT_ID}`);
    const lost = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({ cardNumber: null, cardName: null, cardSeq: null, cardReceivedAt: null }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(lost.key).toBe('bot.payment.gateway_card_unconfirmed');
    expect(lost.values).not.toHaveProperty('cardNumber');
  });

  it('a receipt on its way, or TonPays reporting processing, is "sent" with no second receipt button', () => {
    for (const state of ['QUEUED', 'SENDING'] as const) {
      const reply = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
        latestChange: null,
        submissions: [submission(state)],
      });
      expect(reply.key).toBe('bot.payment.gateway_card_receipt_sent');
      expect(data(reply)).not.toContain(`gr:${PAYMENT_ID}`);
    }
    const processing = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'processing' }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(processing.key).toBe('bot.payment.gateway_card_receipt_sent');
    expect(data(processing)).not.toContain(`gr:${PAYMENT_ID}`);
    const refused = gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
      latestChange: null,
      submissions: [submission('REFUSED')],
    });
    expect(refused.key).toBe('bot.payment.gateway_card_receipt_refused');
    expect(data(refused)).toContain(`gr:${PAYMENT_ID}`);
  });

  it('a created invoice that came with no card cannot be paid here, and offers a new attempt', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({
          creationErrorCode: 'nexa.no_payment_card',
          cardNumber: null,
          cardName: null,
          cardSeq: null,
          cardReceivedAt: null,
        }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_card_missing');
  });

  it('never says paid until the payment is CONFIRMED', () => {
    const confirmed = gatewayAttemptScreen(
      {
        payment: payment({ state: 'CONFIRMED' }),
        invoice: invoice({ providerStatus: 'completed', providerPaid: true }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(confirmed.key).toBe('bot.payment.gateway_confirmed');
    const approvedButPending = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'completed', providerPaid: true }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(approvedButPending.key).not.toBe('bot.payment.gateway_confirmed');
  });

  // -------------------------------------------------------------------------------------
  // Round 6: under- and overpayment, cancel, a rejection, a buyer who holds an invoice
  // -------------------------------------------------------------------------------------

  const provider = (over: Partial<GatewayProviderFacts>): GatewayProviderFacts => ({
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
  // The document's page-17 examples.
  const LESS = provider({
    need: 'LESS',
    remainingAmount: 12_000n,
    remainingCardNumber: '6219861012345678',
    remainingCardHolder: 'Shop Card',
    remainingInvoiceId: 'TP-REM123XYZ0',
    remainingReceiptReceived: false,
  });
  const MORE = provider({ need: 'MORE', refundAmount: 15_000n, refundPending: false });
  const withFacts = (over: Partial<GatewayCardFacts>): GatewayCardFacts => ({
    ...NO_FACTS,
    ...over,
  });
  const request = (
    kind: 'CANCEL' | 'REFUND',
    state: GatewayProviderRequestRecord['state'],
    over: Partial<GatewayProviderRequestRecord> = {},
  ): GatewayProviderRequestRecord => ({
    id: 'r1',
    paymentId: PAYMENT_ID,
    botInstanceId: 'b',
    customerId: 'c',
    kind,
    state,
    requestedAt: AT,
    sentAt: null,
    decidedAt: null,
    errorCode: null,
    refundCardMasked: kind === 'REFUND' ? '603799******7890' : null,
    ...over,
  });
  const screenOf = (
    status: string,
    facts: GatewayCardFacts,
    paymentOver: Partial<PaymentRecord> = {},
    invoiceOver: Partial<GatewayInvoiceRecord> = {},
    at: Date = AT,
  ) =>
    gatewayAttemptScreen(
      {
        payment: payment(paymentOver),
        invoice: invoice({ providerStatus: status, ...invoiceOver }),
      },
      'o',
      at,
      facts,
    );
  const copies = (reply: ReturnType<typeof gatewayAttemptScreen>) =>
    reply.buttons.flatMap((button) => ('copyText' in button ? [button.copyText] : []));

  it('action_required_less: the remainder, its card and exact amount as tap-to-copy, a remainder-receipt button — and never the plain open invoice', () => {
    const reply = screenOf('action_required_less', withFacts({ providerFacts: LESS }));
    expect(reply.key).toBe('bot.payment.gateway_card_underpaid');
    expect(reply.values).toMatchObject({
      shortfall: money(12_000n, 'IRT'),
      cardNumber: '6219861012345678',
      cardName: 'Shop Card',
      expiresAt: EXPIRES_AT,
    });
    expect(copies(reply)).toEqual(['6219861012345678', '12000']);
    expect(data(reply)).toContain(`gr:${PAYMENT_ID}`);
    // The original transfer's card, change and cancel are not offered for an underpaid invoice.
    expect(data(reply)).not.toContain(`gk:${PAYMENT_ID}`);
    expect(data(reply)).not.toContain(`gq:${PAYMENT_ID}`);
    expect(reply.key).not.toBe('bot.payment.gateway_card_invoice');
  });

  it('action_required_less inside the provider’s review window is still the remainder screen, not "in review"; past the settlement deadline it is closed', () => {
    const reviewUntil = new Date(AT.getTime() + 24 * 3_600_000);
    const inReview = screenOf('action_required_less', withFacts({ providerFacts: LESS }), {
      providerReviewStartedAt: AT,
      providerReviewUntil: reviewUntil,
    });
    expect(inReview.key).toBe('bot.payment.gateway_card_underpaid');
    expect(inReview.values).toMatchObject({ expiresAt: reviewUntil });
    const closed = screenOf(
      'action_required_less',
      withFacts({ providerFacts: LESS }),
      {},
      {},
      new Date(EXPIRES_AT.getTime() + 1),
    );
    expect(closed.key).toBe('bot.payment.gateway_closed');
  });

  it('action_required_less: a receipt for the remainder on its way (or already held by TonPays) is shown as sent; no usable remainder is "not available"', () => {
    expect(
      screenOf(
        'action_required_less',
        withFacts({ providerFacts: provider({ ...LESS, remainingReceiptReceived: true }) }),
      ).key,
    ).toBe('bot.payment.gateway_card_underpaid_receipt_sent');
    expect(
      screenOf(
        'action_required_less',
        withFacts({ providerFacts: LESS, submissions: [submission('QUEUED')] }),
      ).key,
    ).toBe('bot.payment.gateway_card_underpaid_receipt_sent');
    for (const missing of [
      provider({ ...LESS, remainingCardNumber: null }),
      provider({ ...LESS, remainingInvoiceId: null }),
      provider({ ...LESS, remainingAmount: null }),
    ]) {
      const reply = screenOf('action_required_less', withFacts({ providerFacts: missing }));
      expect(reply.key).toBe('bot.payment.gateway_card_underpaid_unavailable');
      expect(copies(reply)).toEqual([]);
    }
    expect(screenOf('action_required_less', NO_FACTS).key).toBe(
      'bot.payment.gateway_card_underpaid_unavailable',
    );
  });

  it('action_required_more: asks for the refund card; pending, refused and lost refunds each have their screen', () => {
    const asks = screenOf('action_required_more', withFacts({ providerFacts: MORE }));
    expect(asks.key).toBe('bot.payment.gateway_card_overpaid');
    expect(asks.values).toMatchObject({ refundAmount: money(15_000n, 'IRT') });
    expect(data(asks)).toContain(`gf:${PAYMENT_ID}`);
    expect(data(asks)).not.toContain(`gr:${PAYMENT_ID}`);

    const inFlight = screenOf(
      'action_required_more',
      withFacts({ providerFacts: MORE, latestRefund: request('REFUND', 'REQUESTED') }),
    );
    expect(inFlight.key).toBe('bot.payment.gateway_card_overpaid_pending');
    expect(inFlight.values).toMatchObject({ maskedCard: '603799******7890' });
    expect(data(inFlight)).not.toContain(`gf:${PAYMENT_ID}`);
    expect(
      screenOf(
        'action_required_more',
        withFacts({ providerFacts: provider({ ...MORE, refundPending: true }) }),
      ).key,
    ).toBe('bot.payment.gateway_card_overpaid_pending');

    const refused = (code: string) =>
      screenOf(
        'action_required_more',
        withFacts({
          providerFacts: MORE,
          latestRefund: request('REFUND', 'REFUSED', { errorCode: code }),
        }),
      );
    expect(refused('INVALID_REFUND_CARD').key).toBe('bot.payment.gateway_refund_card_refused');
    expect(data(refused('INVALID_REFUND_CARD'))).toContain(`gf:${PAYMENT_ID}`);
    expect(refused('INVALID_REFUND_HOLDER').key).toBe('bot.payment.gateway_refund_holder_refused');
    expect(refused('REFUND_NOT_ALLOWED').key).toBe('bot.payment.gateway_refund_not_allowed');
    expect(data(refused('REFUND_NOT_ALLOWED'))).not.toContain(`gf:${PAYMENT_ID}`);
    expect(refused('REFUND_ALREADY_OPEN').key).toBe('bot.payment.gateway_refund_already_open');
    expect(
      screenOf(
        'action_required_more',
        withFacts({ providerFacts: MORE, latestRefund: request('REFUND', 'UNKNOWN') }),
      ).key,
    ).toBe('bot.payment.gateway_refund_unknown');
  });

  it('no screen that carries a refund card shows the whole number — only the masked one reaches a value', () => {
    for (const latestRefund of [
      request('REFUND', 'REQUESTED'),
      request('REFUND', 'APPLIED'),
      request('REFUND', 'UNKNOWN'),
    ]) {
      const reply = screenOf(
        'action_required_more',
        withFacts({ providerFacts: MORE, latestRefund }),
      );
      const text = JSON.stringify(reply, (_, value: unknown) =>
        typeof value === 'bigint' ? value.toString() : value,
      );
      expect(text).not.toContain('6037991234567890');
    }
  });

  it('cancel: drawn on a pending invoice only; the request, a refusal and a lost answer have their sentences; the customer’s applied cancel reads "cancelled"', () => {
    expect(data(screenOf('pending', NO_FACTS))).toContain(`gq:${PAYMENT_ID}`);
    for (const status of ['processing', 'action_required_less', 'action_required_more']) {
      expect(
        data(screenOf(status, withFacts({ providerFacts: status === 'processing' ? null : LESS }))),
        status,
      ).not.toContain(`gq:${PAYMENT_ID}`);
    }
    expect(
      data(screenOf('pending', withFacts({ submissions: [submission('QUEUED')] }))),
    ).not.toContain(`gq:${PAYMENT_ID}`);
    expect(screenOf('pending', withFacts({ latestCancel: request('CANCEL', 'SENT') })).key).toBe(
      'bot.payment.gateway_cancel_requested',
    );
    const decidedAt = new Date(AT.getTime() - 1_000);
    const refused = (code: string, lastInquiryAt: Date | null) =>
      screenOf(
        'pending',
        withFacts({
          latestCancel: request('CANCEL', 'REFUSED', { errorCode: code, decidedAt }),
        }),
        {},
        { lastInquiryAt },
      );
    expect(refused('CANCEL_NOT_ALLOWED_PROCESSING', null).key).toBe(
      'bot.payment.gateway_cancel_not_allowed_processing',
    );
    expect(refused('CANCEL_NOT_ALLOWED_NEED_ACTION_LESS', null).key).toBe(
      'bot.payment.gateway_cancel_not_allowed_less',
    );
    expect(refused('CANCEL_NOT_ALLOWED_NEED_ACTION_MORE', null).key).toBe(
      'bot.payment.gateway_cancel_not_allowed_more',
    );
    expect(refused('NOT_PENDING', null).key).toBe('bot.payment.gateway_not_pending');
    // An inquiry answered after the refusal replaces the notice with the invoice as it is now.
    expect(refused('NOT_PENDING', AT).key).toBe('bot.payment.gateway_card_invoice');
    expect(
      screenOf('pending', withFacts({ latestCancel: request('CANCEL', 'UNKNOWN', { decidedAt }) }))
        .key,
    ).toBe('bot.payment.gateway_cancel_unknown');
    const cancelled = screenOf(
      'canceled',
      withFacts({ latestCancel: request('CANCEL', 'APPLIED', { decidedAt }) }),
      { state: 'FAILED' },
    );
    expect(cancelled.key).toBe('bot.payment.gateway_cancelled');
  });

  it('reject_reasons are shown to the customer on a rejected payment, and a payment without any keeps the generic sentence', () => {
    const reasons = ['رسید خوانا نبود', 'نام مطابقت ندارد'];
    const rejected = screenOf(
      'rejected',
      withFacts({ providerFacts: provider({ rejectReasons: reasons }) }),
      { state: 'FAILED' },
    );
    expect(rejected.key).toBe('bot.payment.gateway_card_rejected');
    expect(rejected.values).toMatchObject({ reasons: reasons.join('\n') });
    expect(screenOf('rejected', NO_FACTS, { state: 'FAILED' }).key).toBe(
      'bot.payment.gateway_failed',
    );
  });

  it('a buyer who already holds an invoice is shown THAT invoice and its next step, never a generic error', () => {
    const other = '01a0fa00-0000-7000-8000-0000000000aa';
    for (const [code, key] of [
      ['BUYER_HAS_PENDING_INVOICE', 'bot.payment.gateway_buyer_pending'],
      ['BUYER_HAS_PROCESSING_INVOICE', 'bot.payment.gateway_buyer_processing'],
      ['BUYER_HAS_NEED_ACTION_LESS', 'bot.payment.gateway_buyer_less'],
      ['BUYER_HAS_NEED_ACTION_MORE', 'bot.payment.gateway_buyer_more'],
    ] as const) {
      const reply = gatewayAttemptScreen(
        {
          payment: payment({ state: 'FAILED' }),
          invoice: invoice({
            creationState: 'CREATE_FAILED',
            creationErrorCode: code,
            providerInvoiceId: null,
            providerStatus: null,
          }),
        },
        'o',
        AT,
        withFacts({ openElsewherePaymentId: other }),
      );
      expect(reply.key, code).toBe(key);
      expect(data(reply), code).toContain(`gc:${other}`);
    }
    // Not known to Nexa: the sentence, no button.
    const unknown = gatewayAttemptScreen(
      {
        payment: payment({ state: 'FAILED' }),
        invoice: invoice({
          creationState: 'CREATE_FAILED',
          creationErrorCode: 'BUYER_HAS_PENDING_INVOICE',
          providerStatus: null,
        }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(unknown.key).toBe('bot.payment.gateway_buyer_pending');
    expect(data(unknown).some((one) => one?.startsWith('gc:'))).toBe(false);
  });

  it('a receipt TonPays called empty, or could not match to the invoice, has its own sentence and keeps the card', () => {
    for (const [code, key] of [
      ['EMPTY_RECEIPT', 'bot.payment.gateway_card_receipt_empty'],
      ['INVOICE_ID_MISMATCH', 'bot.payment.gateway_card_receipt_invoice'],
      ['REMAINDER_INVOICE_MISSING', 'bot.payment.gateway_card_receipt_invoice'],
      ['INVALID_RECEIPT_TYPE', 'bot.payment.gateway_card_receipt_refused'],
    ] as const) {
      const reply = screenOf(
        'pending',
        withFacts({ submissions: [{ ...submission('REFUSED'), errorCode: code }] }),
      );
      expect(reply.key, code).toBe(key);
      expect(reply.values, code).toMatchObject({ cardNumber: '6037-9911-0000-1001' });
    }
  });
});
