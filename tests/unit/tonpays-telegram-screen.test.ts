import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  validateTemplateBody,
  type PaymentId,
  type ScopeContext,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import { TemplateResolver } from '../../apps/api/src/modules/control/templates/application/template-resolver';
import { I18nTemplateCatalogue } from '../../apps/api/src/modules/control/templates/infrastructure/i18n-template-catalogue';
import type { TemplateRepository } from '../../apps/api/src/modules/control/templates/application/ports';
import type { FeatureFlagResolver } from '../../apps/api/src/modules/control/features/application/feature-flags.service';
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
  it('shows the card, the payable, TonPays’ own figure apart, and the R8 A2 rows in the customer window', () => {
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
      // R6 item 2: the exact amount as bare digits (it copies as-is), never a Money.
      transferAmount: '250037',
      expiresAt: EXPIRES_AT,
    });
    /*
     * R8 A2: [copy amount (rial)] [copy card] / [change card] / [receipt] [cancel] / [main
     * menu]. No «🔎 بررسی وضعیت»: the inquiry polling and the webhook decide.
     */
    expect(data(reply)).toEqual([
      null, // «📋 کپی مبلغ (ریال)» (copy_text, no callback)
      null, // «💳 کپی شماره کارت»
      `gk:${PAYMENT_ID}`,
      `gr:${PAYMENT_ID}`,
      `gq:${PAYMENT_ID}`,
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
      // v0.8.2 hotfix: TonPays' 12,000 Toman is shown as 120,000 rial; {shortfall} stays.
      amountRial: '۱۲۰٬۰۰۰',
      amountToman: '۱۲٬۰۰۰',
      shortfall: money(12_000n, 'IRT'),
      cardNumber: '6219861012345678',
      cardName: 'Shop Card',
      expiresAt: EXPIRES_AT,
    });
    // The R8 A2 first row: the remainder in rial digits, then the card's sixteen digits.
    expect(copies(reply)).toEqual(['120000', '6219861012345678']);
    expect(data(reply)).toContain(`gr:${PAYMENT_ID}`);
    // The original transfer's card, change and cancel are not offered for an underpaid invoice.
    expect(data(reply)).not.toContain(`gk:${PAYMENT_ID}`);
    expect(data(reply)).not.toContain(`gq:${PAYMENT_ID}`);
    expect(reply.key).not.toBe('bot.payment.gateway_card_invoice');
  });

  /*
   * v0.8.2 hotfix, the owner's case: an invoice of 553,680 rial (55,368 Toman), 500,000 rial
   * paid, so TonPays' `remaining_amount` is 5,368 — TOMAN. The screen said «5,368 تومان کمتر
   * واریز شد» and «💵 کپی مبلغ» copied 5368, which the customer typed into the banking app as
   * rial: ten times too little. The remainder is 53,680 rial, shown and copied as such.
   */
  const OWNER_LESS = provider({ ...LESS, remainingAmount: 5_368n });
  const renderedText = (reply: ReturnType<typeof gatewayAttemptScreen>): string => {
    const key = reply.key as TemplateKey;
    return renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], reply.values);
  };

  it('v0.8.2: the remainder of the owner’s invoice (553,680 rial, 500,000 paid) is shown as 53,680 RIAL, Toman only in brackets, and copied as 53680', () => {
    const reply = screenOf('action_required_less', withFacts({ providerFacts: OWNER_LESS }));
    expect(reply.key).toBe('bot.payment.gateway_card_underpaid');
    expect(copies(reply)).toEqual(['53680', '6219861012345678']);
    // The copy-amount button is the card invoice's own, labelled as rial.
    expect(reply.buttons.find((button) => 'copyText' in button)).toMatchObject({
      inline: 'payment.copy_transfer_amount',
      copyText: '53680',
    });
    const text = renderedText(reply);
    expect(text).toContain('مبلغ مابقی قابل واریز: ۵۳٬۶۸۰ ریال\n(معادل ۵٬۳۶۸ تومان)');
    // The Toman figure appears ONLY as the bracketed equivalent.
    expect(text.split('تومان').length - 1).toBe(1);
    expect(text).not.toContain('5,368');
    expect(text).not.toContain('5368');
    expect(text).not.toMatch(/\{[A-Za-z]+\}/u);
  });

  it('v0.8.2: the remainder receipt on its way restates the remainder in RIAL with Toman in brackets; with none reported, no amount line', () => {
    const sent = screenOf(
      'action_required_less',
      withFacts({ providerFacts: provider({ ...OWNER_LESS, remainingReceiptReceived: true }) }),
    );
    expect(sent.key).toBe('bot.payment.gateway_card_underpaid_receipt_sent');
    const text = renderedText(sent);
    expect(text).toContain('مبلغ مابقی: ۵۳٬۶۸۰ ریال\n(معادل ۵٬۳۶۸ تومان)');
    expect(text.split('تومان').length - 1).toBe(1);
    expect(text).not.toContain('5,368');
    const none = screenOf(
      'action_required_less',
      withFacts({
        providerFacts: provider({
          ...OWNER_LESS,
          remainingAmount: null,
          remainingReceiptReceived: true,
        }),
      }),
    );
    expect(none.key).toBe('bot.payment.gateway_card_underpaid_receipt_sent');
    const bare = renderedText(none);
    expect(bare).not.toContain('مبلغ مابقی');
    expect(bare).not.toContain('تومان');
    expect(bare).not.toMatch(/\{[A-Za-z]+\}/u);
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
        withFacts({
          providerFacts: LESS,
          submissions: [{ ...submission('QUEUED'), providerInvoiceId: 'TP-REM123XYZ0' }],
        }),
      ).key,
    ).toBe('bot.payment.gateway_card_underpaid_receipt_sent');
    // The ORIGINAL receipt (accepted: that is how the shortfall was found) is not the
    // remainder's: the remainder's card and button stay.
    const original = screenOf(
      'action_required_less',
      withFacts({ providerFacts: LESS, submissions: [submission('ACCEPTED')] }),
    );
    expect(original.key).toBe('bot.payment.gateway_card_underpaid');
    expect(data(original)).toContain(`gr:${PAYMENT_ID}`);
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

  it('R11 A8: a lost cancel answer keeps «❌ لغو فاکتور» — on its notice, and on the invoice once an inquiry has answered', () => {
    const decidedAt = new Date(AT.getTime() - 1_000);
    const lost = withFacts({ latestCancel: request('CANCEL', 'UNKNOWN', { decidedAt }) });
    // The notice: the retry, the status check and the main menu.
    const notice = screenOf('pending', lost);
    expect(notice.key).toBe('bot.payment.gateway_cancel_unknown');
    expect(data(notice)).toEqual([`gq:${PAYMENT_ID}`, `gc:${PAYMENT_ID}`, 'mm:']);
    // The owner's screen: the invoice back, its copy buttons AND the cancel button.
    const back = screenOf('pending', lost, {}, { lastInquiryAt: AT });
    expect(back.key).toBe('bot.payment.gateway_card_invoice');
    expect(copies(back)).toHaveLength(2);
    expect(data(back)).toContain(`gq:${PAYMENT_ID}`);
    // A rate-limited cancel (TonPays' 429, or held by the client's own limiter) keeps the same
    // retry — but R12 F3 item 10: it is not a LOST answer, so it has its own sentence («not
    // processed, not cancelled yet, do not pay again»), never «پاسخ تون‌پی دریافت نشد».
    // Nexa's own rate-limited cancel says nothing.
    const limited = request('CANCEL', 'RATE_LIMITED', {
      decidedAt,
      errorCode: 'nexa.rate_limited_locally',
    });
    const busy = screenOf('pending', withFacts({ latestCancel: limited }));
    expect(busy.key).toBe('bot.payment.gateway_cancel_rate_limited');
    expect(data(busy)).toEqual([`gq:${PAYMENT_ID}`, `gc:${PAYMENT_ID}`, 'mm:']);
    const readable = request('CANCEL', 'RATE_LIMITED', {
      decidedAt,
      errorCode: 'RATE_LIMIT_EXCEEDED',
    });
    expect(screenOf('pending', withFacts({ latestCancel: readable })).key).toBe(
      'bot.payment.gateway_cancel_rate_limited',
    );
    // R12 F3 lead review: its «tap ❌ لغو فاکتور again» sentence only while that button is
    // offered. A receipt on its way withdraws the button, so the notice drops the sentence.
    const noButton = screenOf(
      'pending',
      withFacts({ latestCancel: readable, submissions: [submission('QUEUED')] }),
    );
    expect(noButton.key).toBe('bot.payment.gateway_cancel_rate_limited_closed');
    expect(data(noButton)).not.toContain(`gq:${PAYMENT_ID}`);
    // A genuinely lost answer (UNKNOWN: a timeout, a 5xx, a bare 429) keeps the old sentence.
    expect(
      screenOf('pending', withFacts({ latestCancel: request('CANCEL', 'UNKNOWN', { decidedAt }) }))
        .key,
    ).toBe('bot.payment.gateway_cancel_unknown');
    const ours = screenOf(
      'pending',
      withFacts({ latestCancel: { ...limited, requestedByNexa: true } }),
    );
    expect(ours.key).toBe('bot.payment.gateway_card_invoice');
    expect(data(ours)).toContain(`gq:${PAYMENT_ID}`);
    // Not once the invoice moved on, was reported paid, or the customer window closed.
    expect(data(screenOf('processing', lost))).not.toContain(`gq:${PAYMENT_ID}`);
    expect(data(screenOf('pending', lost, {}, { providerPaid: true }))).not.toContain(
      `gq:${PAYMENT_ID}`,
    );
    expect(
      data(screenOf('pending', lost, {}, {}, new Date(EXPIRES_AT.getTime() + 1_000))),
    ).not.toContain(`gq:${PAYMENT_ID}`);
    // Nor while a retry is with the provider: "cancelling…", no button.
    const again = screenOf('pending', withFacts({ latestCancel: request('CANCEL', 'REQUESTED') }));
    expect(again.key).toBe('bot.payment.gateway_cancel_requested');
    expect(data(again)).not.toContain(`gq:${PAYMENT_ID}`);
  });

  it('R11 A8: a card change whose answer was lost hides the card and keeps both the card change and the cancel', () => {
    const changeLost: GatewayCardFacts['latestChange'] = {
      id: 'k1',
      paymentId: PAYMENT_ID,
      botInstanceId: 'b',
      customerId: 'c',
      state: 'UNKNOWN',
      requestedAt: new Date(AT.getTime() - 120_000),
      sentAt: new Date(AT.getTime() - 120_000),
      decidedAt: new Date(AT.getTime() - 120_000),
      errorCode: 'http.timeout',
    };
    const reply = screenOf(
      'pending',
      withFacts({ latestChange: changeLost }),
      {},
      { cardNumber: null },
    );
    expect(reply.key).toBe('bot.payment.gateway_card_unconfirmed');
    expect(data(reply)).toContain(`gk:${PAYMENT_ID}`);
    expect(data(reply)).toContain(`gq:${PAYMENT_ID}`);
    // Both lost at once: still both.
    const both = screenOf(
      'pending',
      withFacts({
        latestChange: changeLost,
        latestCancel: request('CANCEL', 'UNKNOWN', { decidedAt: new Date(AT.getTime() - 1_000) }),
      }),
      {},
      { cardNumber: null, lastInquiryAt: AT },
    );
    expect(data(both)).toContain(`gk:${PAYMENT_ID}`);
    expect(data(both)).toContain(`gq:${PAYMENT_ID}`);
  });

  it('R11 A8: the customer’s cancel that the inquiry found applied reads "cancelled", not "failed"; Nexa’s own or none keeps "failed"', () => {
    const failed = { state: 'FAILED' as const, resolutionNote: 'tonpays_telegram:canceled' };
    const refused = request('CANCEL', 'REFUSED', { errorCode: 'NOT_PENDING', decidedAt: AT });
    expect(screenOf('canceled', withFacts({ latestCancel: refused }), failed).key).toBe(
      'bot.payment.gateway_cancelled',
    );
    expect(
      screenOf('canceled', withFacts({ latestCancel: request('CANCEL', 'UNKNOWN') }), failed).key,
    ).toBe('bot.payment.gateway_cancelled');
    expect(
      screenOf(
        'canceled',
        withFacts({ latestCancel: { ...refused, requestedByNexa: true } }),
        failed,
      ).key,
    ).toBe('bot.payment.gateway_failed');
    expect(screenOf('canceled', NO_FACTS, failed).key).toBe('bot.payment.gateway_failed');
    expect(
      screenOf('rejected', withFacts({ latestCancel: refused }), {
        state: 'FAILED',
        resolutionNote: 'tonpays_telegram:rejected',
      }).key,
    ).toBe('bot.payment.gateway_failed');
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

/**
 * R6 item 2. TonPays approves automatically only on the EXACT (odd) amount it named, so the
 * card screens name that amount — and only that — as the thing to transfer, as bare digits in
 * <code>, with a copy button carrying the same digits.
 */
describe('R6 item 2: the card screens show the exact amount to transfer', () => {
  const CARD_KEYS = [
    'bot.payment.gateway_card_invoice',
    'bot.payment.gateway_card_receipt_sent',
    'bot.payment.gateway_card_receipt_refused',
    'bot.payment.gateway_card_changing',
  ] as const satisfies readonly TemplateKey[];

  const screens = () => ({
    invoice: gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, NO_FACTS),
    sent: gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'processing' }) },
      'o',
      AT,
      NO_FACTS,
    ),
    refused: gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
      latestChange: null,
      submissions: [submission('REFUSED')],
    }),
    changing: gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, {
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
    }),
  });

  it('R8 A2: the invoice and all three follow-ups show the exact amount in RIAL, bold, with Toman beside it', () => {
    const all = screens();
    for (const [name, reply] of Object.entries(all)) {
      const key = reply.key as (typeof CARD_KEYS)[number];
      expect(CARD_KEYS, name).toContain(key);
      const text = renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], reply.values);
      // 250,037 Toman (TonPays' exact figure) is 2,500,370 rial.
      expect(text, name).toContain('<b>۲٬۵۰۰٬۳۷۰ ریال</b>');
      expect(text, name).toContain('(معادل ۲۵۰٬۰۳۷ تومان)');
      // Never the fee word, never the bare Toman digits as the instruction.
      expect(text, name).not.toContain('کارمزد');
      expect(text, name).not.toContain('250037');
    }
  });

  it('with no figure from TonPays the exact amount is the payable, so a body that needs it can always render', () => {
    const reply = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: null }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.values).toMatchObject({ transferAmount: '250000' });
    // With a 10% customer fee the payable (not the principal) is what must be transferred.
    const fee = gatewayAttemptScreen(
      {
        payment: payment({
          customerFee: {
            basisPoints: 1000,
            fee: money(25_000n, 'IRT'),
            payable: money(275_000n, 'IRT'),
          },
        }),
        // What Nexa sent is the payable in the provider's unit.
        invoice: invoice({ finalAmount: null, sentAmount: 275_000n }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(fee.values).toMatchObject({ transferAmount: '275000' });
    // An IRR payment: the payable is rial, the provider's figure is Toman. The customer is
    // told the Toman figure, never 2,500,000 "Toman" (Codex review of #312).
    const rial = gatewayAttemptScreen(
      {
        payment: payment({ amount: money(2_500_000n, 'IRR') }),
        invoice: invoice({ finalAmount: null, sentAmount: 250_000n }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(rial.values).toMatchObject({ transferAmount: '250000' });
  });

  it('after a card change the screen shows the NEW exact amount the invoice now holds', () => {
    const before = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: 250_037n }) },
      'o',
      AT,
      NO_FACTS,
    );
    const after = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: 250_091n, cardSeq: 2 }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(before.values).toMatchObject({ transferAmount: '250037' });
    expect(after.values).toMatchObject({ transferAmount: '250091' });
  });

  it('R8 A2: the copy buttons carry rial digits and the sixteen card digits — no separators, no unit', () => {
    for (const [name, reply] of Object.entries(screens())) {
      const copy = reply.buttons.flatMap((button) =>
        'copyText' in button ? [button.copyText] : [],
      );
      if (name === 'changing') {
        expect(copy, name).toEqual([]);
        continue;
      }
      expect(copy, name).toEqual(['2500370', '6037991100001001']);
    }
    // The copy value of a larger amount still has no grouping, and is rial.
    const big = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: 12_345_678n }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(big.buttons.find((button) => 'copyText' in button)).toMatchObject({
      copyText: '123456780',
    });
  });

  it('R8 A2: {amountRial} is required and {transferAmount} and {payable} are not, on all four card templates', () => {
    for (const key of CARD_KEYS) {
      const definition = templateDefinition(key);
      const required = definition.placeholders.filter((p) => p.required).map((p) => p.token);
      expect(required, key).toContain('amountRial');
      expect(required, key).not.toContain('transferAmount');
      expect(required, key).not.toContain('payable');
      const bodyOf = (tokens: readonly string[]) => tokens.map((token) => `{${token}}`).join(' ');
      // Every required token and NO {payable}: saves.
      expect(validateTemplateBody(definition, bodyOf(required)), key).toEqual([]);
      // The same without {amountRial}: refused for exactly that token.
      const without = validateTemplateBody(
        definition,
        `${bodyOf(required.filter((token) => token !== 'amountRial'))} {payable}`,
      );
      expect(
        without.map((issue) => [issue.kind, issue.token]),
        key,
      ).toEqual([['MISSING_REQUIRED_PLACEHOLDER', 'amountRial']]);
    }
  });

  it('an existing override that lacks {transferAmount} keeps rendering exactly as written', async () => {
    const key = 'bot.payment.gateway_card_invoice' as TemplateKey;
    const stored = 'متن قدیمی مدیر: {payable} به {cardNumber} تا {expiresAt}';
    const at = new Date('2026-10-09T10:00:00Z');
    const repository = {
      findOverride: async () => ({
        key,
        locale: 'fa',
        body: stored,
        version: 1,
        revision: 1,
        updatedAt: at,
      }),
    } as unknown as TemplateRepository;
    const resolver = new TemplateResolver(
      repository,
      { isEnabled: async () => true } as unknown as FeatureFlagResolver,
      new I18nTemplateCatalogue(),
      { presentationFor: async () => ({ timezone: 'UTC', calendar: 'gregorian' }) as never },
    );
    const reply = screens().invoice;
    const text = await resolver.render(
      { tenantId: 't-1', botInstanceId: null } as unknown as ScopeContext,
      key,
      reply.values,
    );
    expect(text).toContain('متن قدیمی مدیر:');
    expect(text).toContain('250,000');
    expect(text).not.toContain('{');
  });
});
