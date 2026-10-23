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

const NO_FACTS: GatewayCardFacts = { latestChange: null, submissions: [] };
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
      // R6 item 2: the exact amount as bare digits (it copies as-is), never a Money.
      transferAmount: '250037',
      expiresAt: EXPIRES_AT,
    });
    expect(data(reply)).toEqual([
      null, // «📋 کپی مبلغ دقیق» (copy_text, no callback)
      `gr:${PAYMENT_ID}`,
      `gk:${PAYMENT_ID}`,
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

  it('the invoice and all three follow-ups render the exact amount in <code>', () => {
    const all = screens();
    for (const [name, reply] of Object.entries(all)) {
      const key = reply.key as (typeof CARD_KEYS)[number];
      expect(CARD_KEYS, name).toContain(key);
      const text = renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], reply.values);
      expect(text, name).toContain('<code>250037</code>');
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
        invoice: invoice({ finalAmount: null }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(fee.values).toMatchObject({ transferAmount: '275000' });
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

  it('the copy button carries digits only — no separators, no unit — and matches the text', () => {
    for (const [name, reply] of Object.entries(screens())) {
      const copy = reply.buttons.filter((button) => 'copyText' in button);
      if (name === 'changing') {
        expect(copy, name).toHaveLength(0);
        continue;
      }
      expect(copy, name).toHaveLength(1);
      const value = (copy[0] as { copyText: string }).copyText;
      expect(value, name).toMatch(/^[0-9]+$/u);
      expect(value, name).toBe('250037');
    }
    // The copy value of a larger amount still has no grouping.
    const big = gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ finalAmount: 12_345_678n }) },
      'o',
      AT,
      NO_FACTS,
    );
    expect(big.buttons.find((button) => 'copyText' in button)).toMatchObject({
      copyText: '12345678',
    });
  });

  it('{transferAmount} is required and {payable} is not, on all four card templates', () => {
    for (const key of CARD_KEYS) {
      const definition = templateDefinition(key);
      const required = definition.placeholders.filter((p) => p.required).map((p) => p.token);
      expect(required, key).toContain('transferAmount');
      expect(required, key).not.toContain('payable');
      const bodyOf = (tokens: readonly string[]) => tokens.map((token) => `{${token}}`).join(' ');
      // Every required token and NO {payable}: saves.
      expect(validateTemplateBody(definition, bodyOf(required)), key).toEqual([]);
      // The same without {transferAmount}: refused for exactly that token.
      const without = validateTemplateBody(
        definition,
        `${bodyOf(required.filter((token) => token !== 'transferAmount'))} {payable}`,
      );
      expect(
        without.map((issue) => [issue.kind, issue.token]),
        key,
      ).toEqual([['MISSING_REQUIRED_PLACEHOLDER', 'transferAmount']]);
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
