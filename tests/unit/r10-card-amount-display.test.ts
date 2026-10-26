import { describe, expect, it } from 'vitest';
import {
  money,
  templateDefinition,
  validateTemplateBody,
  type PaymentId,
  type TenantContext,
  type TemplateKey,
  type UserId,
} from '@nexa/contracts';
import { CATALOGUE_FA, renderTemplateBody } from '@nexa/i18n';
import { gatewayAttemptScreen } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import { transferInstruction } from '../../apps/api/src/surfaces/telegram/runtime/card-receipt-flow';
import type { BotRuntime } from '../../apps/api/src/surfaces/telegram/bot-runtime';
import type { PaymentRecord } from '../../apps/api/src/modules/commerce/payments/application/ports';
import type {
  GatewayInvoiceRecord,
  GatewayProviderFacts,
} from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';
import type { GatewayCardFacts } from '../../apps/api/src/modules/commerce/payments/application/gateway-payment.service';

/**
 * R10 B6: every amount a card-to-card screen states reads as the R8 A2 invoice states it — in
 * RIAL, Persian digits, with the Toman figure only in brackets on the line beneath — and none
 * of them breaks the amount into principal and «کارمزد». Pinned on the exact rendered Persian
 * text of the catalogue bodies, from the values the screens themselves build.
 *
 * Display only: the figures are what the customer was told to transfer (or what TonPays says
 * it returns); nothing here is what Nexa settles, credits or refunds.
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-0000000000b6' as PaymentId;
const CREATED_AT = new Date('2026-10-26T08:00:00Z');
const EXPIRES_AT = new Date('2026-10-26T09:10:00Z');
const AT = new Date('2026-10-26T08:30:00Z');

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

const textOf = (key: TemplateKey, values: Parameters<typeof renderTemplateBody>[2]): string =>
  renderTemplateBody(templateDefinition(key), CATALOGUE_FA[key], values);
const rendered = (reply: ReturnType<typeof gatewayAttemptScreen>): string =>
  textOf(reply.key as TemplateKey, reply.values);

/** The amount line and its bracket, exactly; the Toman figure nowhere else; no token left. */
function expectRialWithTomanBracket(text: string, line: string, rial: string, toman: string) {
  expect(text).toContain(`${line} ${rial} ریال\n(معادل ${toman} تومان)`);
  expect(text.split('تومان').length - 1).toBe(1);
  expect(text).not.toContain('کارمزد');
  expect(text).not.toMatch(/\{[A-Za-z]+\}/u);
}

describe('R10 B6: the TonPays review screen states the amount in RIAL, Toman in brackets', () => {
  const reviewUntil = new Date(AT.getTime() + 24 * 3_600_000);
  const inReview = (
    paymentOver: Partial<PaymentRecord>,
    invoiceOver: Partial<GatewayInvoiceRecord>,
  ) =>
    gatewayAttemptScreen(
      {
        payment: payment({
          providerReviewStartedAt: AT,
          providerReviewUntil: reviewUntil,
          ...paymentOver,
        }),
        invoice: invoice(invoiceOver),
      },
      'o',
      new Date(EXPIRES_AT.getTime() + 3_600_000),
      NO_FACTS,
    );

  it('the figure the invoice told the customer to transfer (TonPays’ exact 250,037 Toman) as 2,500,370 rial', () => {
    const reply = inReview({}, {});
    expect(reply.key).toBe('bot.payment.gateway_in_review');
    const text = rendered(reply);
    expectRialWithTomanBracket(text, 'مبلغ قابل پرداخت:', '۲٬۵۰۰٬۳۷۰', '۲۵۰٬۰۳۷');
    // Before R10 B6 this screen said «۲۵۰٬۰۰۰ تومان» — the payable, not what was transferred.
    expect(text).not.toContain('۲۵۰٬۰۰۰ تومان');
    // The card invoice states the same figure the same way.
    const invoiceText = rendered(
      gatewayAttemptScreen({ payment: payment(), invoice: invoice() }, 'o', AT, NO_FACTS),
    );
    expect(invoiceText).toContain('<b>۲٬۵۰۰٬۳۷۰ ریال</b>\n(معادل ۲۵۰٬۰۳۷ تومان)');
  });

  it('with a customer fee and no TonPays figure: the payable Nexa sent, one amount, no fee named', () => {
    const reply = inReview(
      {
        customerFee: {
          basisPoints: 1000,
          fee: money(25_000n, 'IRT'),
          payable: money(275_000n, 'IRT'),
        },
      },
      { finalAmount: null, sentAmount: 275_000n },
    );
    expectRialWithTomanBracket(rendered(reply), 'مبلغ قابل پرداخت:', '۲٬۷۵۰٬۰۰۰', '۲۷۵٬۰۰۰');
  });

  it('a link gateway in review states its payable the same way', () => {
    const reply = inReview(
      { gatewayProvider: 'TETRAPAY' },
      { provider: 'TETRAPAY', finalAmount: null, cardNumber: null },
    );
    expect(reply.key).toBe('bot.payment.gateway_in_review');
    expectRialWithTomanBracket(rendered(reply), 'مبلغ قابل پرداخت:', '۲٬۵۰۰٬۰۰۰', '۲۵۰٬۰۰۰');
  });
});

describe('R10 B6: a lost card change states the amount in RIAL, Toman in brackets', () => {
  it('gateway_card_unconfirmed: «مبلغ قابل پرداخت: ۲٬۵۰۰٬۳۷۰ ریال» and «(معادل ۲۵۰٬۰۳۷ تومان)»', () => {
    const reply = gatewayAttemptScreen(
      {
        payment: payment(),
        invoice: invoice({ cardNumber: null, cardName: null, cardSeq: null, cardReceivedAt: null }),
      },
      'o',
      AT,
      NO_FACTS,
    );
    expect(reply.key).toBe('bot.payment.gateway_card_unconfirmed');
    expectRialWithTomanBracket(rendered(reply), 'مبلغ قابل پرداخت:', '۲٬۵۰۰٬۳۷۰', '۲۵۰٬۰۳۷');
  });
});

describe('R10 B6: the overpaid screens state the amount returned in RIAL, Toman in brackets', () => {
  const more = (
    refundAmount: bigint | null,
    latestRefund: GatewayCardFacts['latestRefund'] = null,
  ) =>
    gatewayAttemptScreen(
      { payment: payment(), invoice: invoice({ providerStatus: 'action_required_more' }) },
      'o',
      AT,
      {
        ...NO_FACTS,
        providerFacts: provider({ need: 'MORE', refundAmount, refundPending: false }),
        latestRefund,
      },
    );

  it('asks for the refund card: TonPays’ 15,000 Toman is «۱۵۰٬۰۰۰ ریال», «(معادل ۱۵٬۰۰۰ تومان)»', () => {
    const reply = more(15_000n);
    expect(reply.key).toBe('bot.payment.gateway_card_overpaid');
    expectRialWithTomanBracket(rendered(reply), 'مبلغ قابل بازگشت:', '۱۵۰٬۰۰۰', '۱۵٬۰۰۰');
    // {refundAmount} is still supplied for an override written for the earlier text.
    expect(reply.values).toMatchObject({ refundAmount: money(15_000n, 'IRT') });
  });

  it('the refund on its way states it the same way', () => {
    const reply = more(15_000n, {
      id: 'r1',
      paymentId: PAYMENT_ID,
      botInstanceId: 'b',
      customerId: 'c',
      kind: 'REFUND',
      state: 'REQUESTED',
      requestedAt: AT,
      sentAt: null,
      decidedAt: null,
      errorCode: null,
      refundCardMasked: '603799******7890',
    });
    expect(reply.key).toBe('bot.payment.gateway_card_overpaid_pending');
    expectRialWithTomanBracket(rendered(reply), 'مبلغ قابل بازگشت:', '۱۵۰٬۰۰۰', '۱۵٬۰۰۰');
  });

  it('with no figure from TonPays, no amount line at all — never an empty «ریال»', () => {
    const text = rendered(more(null));
    expect(text).not.toContain('مبلغ قابل بازگشت');
    expect(text).not.toContain('ریال');
    expect(text).not.toContain('معادل');
    expect(text).not.toMatch(/\{[A-Za-z]+\}/u);
  });
});

describe('R10 B6: the manual invoice without a card states the amount in RIAL, Toman in brackets', () => {
  const scope = { tenantId: 't', botInstanceId: 'b' } as unknown as TenantContext;
  // With no destination the instruction reads no card, no switch and no renderer.
  const rt = { deps: {} } as unknown as BotRuntime;

  it('bot.payment.manual_instructions: the payable, fee included, as one rial figure', async () => {
    const reply = await transferInstruction(
      rt,
      scope,
      {
        payment: payment({
          method: 'MANUAL_TRANSFER',
          gatewayProvider: null,
          customerFee: {
            basisPoints: 1000,
            fee: money(47_000n, 'IRT'),
            payable: money(517_000n, 'IRT'),
          },
          amount: money(470_000n, 'IRT'),
        }),
        destination: null,
      },
      null,
    );
    expect(reply.key).toBe('bot.payment.manual_instructions');
    const text = rendered(reply as ReturnType<typeof gatewayAttemptScreen>);
    expectRialWithTomanBracket(text, 'مبلغ قابل واریز:', '۵٬۱۷۰٬۰۰۰', '۵۱۷٬۰۰۰');
    expect(text).not.toContain('۴۷۰٬۰۰۰');
    expect(text).not.toContain('۴۷٬۰۰۰');
  });
});

describe('R10 B6: {amountRial} is required where the screen always has an amount', () => {
  it.each([
    ['bot.payment.gateway_card_unconfirmed', 'payable'],
    ['bot.payment.gateway_in_review', 'payable'],
    ['bot.payment.manual_instructions', 'total'],
  ] as const)('%s: an override must name {amountRial}; {%s} is optional', (key, old) => {
    const definition = templateDefinition(key);
    const required = definition.placeholders.filter((p) => p.required).map((p) => p.token);
    expect(required).toContain('amountRial');
    expect(required).not.toContain(old);
    const without = validateTemplateBody(
      definition,
      [...required.filter((token) => token !== 'amountRial'), old].map((t) => `{${t}}`).join(' '),
    );
    expect(without.map((issue) => [issue.kind, issue.token])).toEqual([
      ['MISSING_REQUIRED_PLACEHOLDER', 'amountRial'],
    ]);
  });
});
