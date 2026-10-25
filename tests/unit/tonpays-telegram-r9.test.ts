import { describe, expect, it } from 'vitest';
import {
  TONPAYS_TELEGRAM_ERROR_CODES,
  money,
  templateDefinition,
  type DomainEvent,
  type TemplateKey,
  type TemplateValues,
} from '@nexa/contracts';
import {
  CATALOGUE_FA,
  DEFAULT_TEMPLATE_PRESENTATION,
  TONPAYS_REJECT_REASONS_FA,
  rejectReasonFa,
  renderTemplateBody,
} from '@nexa/i18n';
import { providerFactsOf } from '../../apps/api/src/modules/commerce/payments/infrastructure/tonpays-telegram-adapter';
import {
  customerMessageKeyOfError,
  needActionKindAgrees,
} from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';
import {
  creditAmountDiffers,
  principalInProviderUnit,
} from '../../apps/api/src/modules/commerce/payments/domain/credit-amount';
import { i18nOpsLogWords } from '../../apps/api/src/modules/commerce/ops-log/infrastructure/i18n-ops-log-words';
import { FinancialLogConsumer } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import { assemblePaymentTimeline } from '../../apps/api/src/modules/commerce/payments/domain/payment-timeline';

/**
 * R9 C1 — TonPays Telegram under/overpayment, `need_action_kind`, `credit_amount`, and the
 * Persian the customer and the operator read. Pure: no database, no network.
 *
 * MUTATION (each reverted, the named test failed, restored with git checkout):
 *  - `needActionKindAgrees` always true -> 'a kind that contradicts the status…';
 *  - `creditAmountDiffers` ignoring `sentAmount` -> 'credit_amount equal to the payable…';
 *  - `rejectReasonFa` returning the reason unchanged -> 'a documented code reads in Persian…'.
 */

const LESS_ANSWER = {
  invoice_id: 'TP-CG123XYZ0',
  order_id: 'CG-TG-1001',
  status: 'action_required_less',
  paid: false,
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
  need_action_kind: 'more',
  remaining_amount: null,
  remaining_invoice_id: null,
  remaining_card_number: null,
  remaining_card_holder: null,
  refund_amount: 15000,
  refund_pending: true,
};

describe('need_action_kind is a cross-check of the status, never a second source of a next step', () => {
  it('agrees when absent, null, or the same kind in any case', () => {
    expect(needActionKindAgrees('LESS', undefined)).toBe(true);
    expect(needActionKindAgrees('LESS', null)).toBe(true);
    expect(needActionKindAgrees('LESS', 'less')).toBe(true);
    expect(needActionKindAgrees('LESS', ' LESS ')).toBe(true);
    expect(needActionKindAgrees('MORE', 'more')).toBe(true);
    expect(needActionKindAgrees(null, 'whatever')).toBe(true);
  });

  it('disagrees for the other kind, an undocumented word, or a non-string', () => {
    expect(needActionKindAgrees('LESS', 'more')).toBe(false);
    expect(needActionKindAgrees('MORE', 'less')).toBe(false);
    expect(needActionKindAgrees('LESS', 'partial')).toBe(false);
    expect(needActionKindAgrees('LESS', 1)).toBe(false);
    expect(needActionKindAgrees('MORE', true)).toBe(false);
  });

  it('a kind that contradicts the status keeps the step (the status decides) and drops every detail: no card, no amount, no remainder invoice', () => {
    expect(providerFactsOf('action_required_less', LESS_ANSWER)).toMatchObject({
      need: 'LESS',
      remainingAmount: 12000n,
      remainingCardNumber: '6219861012345678',
      remainingInvoiceId: 'TP-REM123XYZ0',
    });
    expect(
      providerFactsOf('action_required_less', { ...LESS_ANSWER, need_action_kind: 'more' }),
    ).toEqual({
      need: 'LESS',
      remainingAmount: null,
      remainingCardNumber: null,
      remainingCardHolder: null,
      remainingInvoiceId: null,
      remainingReceiptReceived: null,
      refundAmount: null,
      refundPending: null,
      rejectReasons: [],
    });
    expect(
      providerFactsOf('action_required_more', { ...MORE_ANSWER, need_action_kind: 'less' }),
    ).toMatchObject({ need: 'MORE', refundAmount: null, refundPending: null });
    expect(providerFactsOf('action_required_more', MORE_ANSWER)).toMatchObject({
      need: 'MORE',
      refundAmount: 15000n,
      refundPending: true,
    });
  });

  it('`need_action` with a kind stays an open status with no next step (OQ-TPTG-27): the combination is undocumented', () => {
    expect(providerFactsOf('need_action', { ...LESS_ANSWER, status: 'need_action' })).toBeNull();
    expect(providerFactsOf('need_action', { ...MORE_ANSWER, status: 'need_action' })).toBeNull();
  });
});

describe('credit_amount: shown and flagged, never credited', () => {
  const irt = (amount: bigint) => money(amount, 'IRT');

  it('the principal in the provider unit: a unit change only, never a rate', () => {
    expect(principalInProviderUnit(irt(100_000n), 'IRT')).toBe(100_000n);
    expect(principalInProviderUnit(money(1_000_000n, 'IRR'), 'IRT')).toBe(100_000n);
    expect(principalInProviderUnit(money(1_000_005n, 'IRR'), 'IRT')).toBeNull();
    expect(principalInProviderUnit(irt(100_000n), 'IRR')).toBe(1_000_000n);
    expect(principalInProviderUnit(money(1_000n, 'USD'), 'IRT')).toBeNull();
  });

  it('credit_amount equal to the payable or to the principal is no alert; anything else is', () => {
    const base = { sentAmount: 110_000n, principalInProviderUnit: 100_000n };
    expect(creditAmountDiffers({ ...base, creditAmount: null })).toBe(false);
    expect(creditAmountDiffers({ ...base, creditAmount: 110_000n })).toBe(false);
    expect(creditAmountDiffers({ ...base, creditAmount: 100_000n })).toBe(false);
    expect(creditAmountDiffers({ ...base, creditAmount: 99_000n })).toBe(true);
    expect(creditAmountDiffers({ ...base, creditAmount: 0n })).toBe(true);
    // The provider's own exact transfer figure (request + its unique tail) is a match too.
    expect(
      creditAmountDiffers({ ...base, providerFinalAmount: 110_037n, creditAmount: 110_037n }),
    ).toBe(false);
    expect(
      creditAmountDiffers({ ...base, providerFinalAmount: null, creditAmount: 110_037n }),
    ).toBe(true);
    // No exact principal in the provider's unit: only what was invoiced counts as a match.
    expect(
      creditAmountDiffers({
        sentAmount: 110_000n,
        principalInProviderUnit: null,
        creditAmount: 100_000n,
      }),
    ).toBe(true);
  });

  it('the history’s webhook entry carries the figure and the flag', () => {
    const at = new Date('2026-10-25T10:00:00.000Z');
    const view = assemblePaymentTimeline({
      payment: {
        id: 'p',
        method: 'GATEWAY',
        state: 'PENDING',
        amountMinor: 100_000n,
        currency: 'IRT',
        createdAt: at,
        customerSignalledAt: null,
        confirmedAt: null,
        evidenceKind: null,
        confirmedByAdminId: null,
        resolvedAt: null,
        resolvedByAdminId: null,
      },
      receiptCredit: null,
      notifications: [],
      receipts: [],
      walletEntries: [],
      refunds: [],
      gateway: {
        provider: 'TONPAYS_TELEGRAM',
        createdAt: at,
        creationState: 'CREATED',
        creationErrorCode: null,
        creationSentAt: at,
        createdInvoiceAt: at,
        providerInvoiceId: 'TP-1',
        lastWebhookAt: at,
        webhookStatusHint: 'processing',
        webhookCount: 2,
        creditAmount: 99_000n,
        sentAmount: 100_000n,
        providerUnit: 'IRT',
        lastInquiryAt: null,
        providerStatus: null,
        providerPaid: null,
        lastInquiryErrorCode: null,
        outcome: null,
        outcomeAt: null,
        lateCompletionObservedAt: null,
      },
    } as never);
    expect(view.entries.find((one) => one.kind === 'GATEWAY_WEBHOOK_HINT')).toMatchObject({
      creditAmount: '99000',
      providerUnit: 'IRT',
      creditAmountDiffers: true,
    });
  });
});

describe('reject_reasons: a documented code reads in Persian, anything else as worded', () => {
  it('a documented code reads in Persian, in any case; unknown tokens and prose are unchanged', () => {
    expect(rejectReasonFa('EMPTY_RECEIPT')).toBe(TONPAYS_REJECT_REASONS_FA.EMPTY_RECEIPT);
    expect(rejectReasonFa('invoice_id_mismatch')).toBe(
      TONPAYS_REJECT_REASONS_FA.INVOICE_ID_MISMATCH,
    );
    expect(rejectReasonFa('low_balance')).toBe('low_balance');
    expect(rejectReasonFa('مبلغ رسید با فاکتور نمی‌خواند')).toBe('مبلغ رسید با فاکتور نمی‌خواند');
    for (const text of Object.values(TONPAYS_REJECT_REASONS_FA)) {
      expect(text).toMatch(/\p{Script=Arabic}/u);
      expect(text).not.toMatch(/[A-Za-z]/u);
    }
  });

  it('the operations log quotes a gateway’s documented code in Persian, an operator’s reason as written', () => {
    expect(i18nOpsLogWords.rejectReasons('PROVIDER', ['EMPTY_RECEIPT', 'low_balance'])).toContain(
      TONPAYS_REJECT_REASONS_FA.EMPTY_RECEIPT,
    );
    expect(i18nOpsLogWords.rejectReasons('PROVIDER', ['low_balance'])).toContain('low_balance');
    expect(i18nOpsLogWords.rejectReasons('OPERATOR', ['EMPTY_RECEIPT'])).toContain('EMPTY_RECEIPT');
  });
});

describe('every documented error code reaches the customer in Persian only', () => {
  it('each of the 24 codes has a customer template whose text has no Latin letters', () => {
    expect(TONPAYS_TELEGRAM_ERROR_CODES).toHaveLength(24);
    for (const code of TONPAYS_TELEGRAM_ERROR_CODES) {
      const key = customerMessageKeyOfError(code);
      expect(key, code).not.toBeNull();
      const body = CATALOGUE_FA[key!];
      expect(body, code).toMatch(/\p{Script=Arabic}/u);
      // Placeholders are filled with values (amounts, codes of the payment), not English words.
      expect(body.replace(/\{[^}]+\}/gu, ''), code).not.toMatch(/[A-Za-z]{2,}/u);
    }
  });
});

describe('the financial log renders the three new headlines from the event alone', () => {
  async function render(
    reason: 'UNDERPAID' | 'OVERPAID' | 'CREDIT_AMOUNT_MISMATCH',
  ): Promise<{ key: string; text: string } | null> {
    const queued: { templateKey: TemplateKey; values: TemplateValues }[] = [];
    const payment = {
      id: 'p-1',
      source: 'NEXA',
      customerId: 'c-1',
      orderId: null,
      state: 'PENDING',
      method: 'GATEWAY',
      amount: money(100_000n, 'IRT'),
      reference: 'ABCDEFGH',
      code: 'ABCDEFGH',
      customerFee: null,
      gatewayProvider: 'TONPAYS_TELEGRAM',
      resolutionNote: null,
      resolvedAt: null,
    };
    const consumer = new FinancialLogConsumer({
      lane: {
        financialDestination: async () =>
          ({ transport: 'TELEGRAM', chatId: '-1001', topicId: null }) as never,
        queue: async (_scope, input) => {
          queued.push({ templateKey: input.templateKey, values: input.values });
          return undefined;
        },
      },
      payments: { findById: async () => payment as never },
      customers: { findById: async () => null },
      invoices: {
        findByPayment: async () =>
          ({
            providerInvoiceId: 'TP-1',
            providerUnit: 'IRT',
            sentAmount: 100_000n,
            creditAmount: 99_000n,
          }) as never,
      },
      facts: { order: async () => null } as never,
      words: i18nOpsLogWords,
      refundRequests: { findById: async () => null } as never,
      providerRequests: {
        latest: async () => null,
        factsFor: async () =>
          ({
            need: reason === 'UNDERPAID' ? 'LESS' : 'MORE',
            remainingAmount: reason === 'UNDERPAID' ? 12_000n : null,
            remainingInvoiceId: reason === 'UNDERPAID' ? 'TP-REM1' : null,
            refundAmount: reason === 'OVERPAID' ? 15_000n : null,
          }) as never,
      },
    });
    const event = {
      eventId: 'e-1',
      eventType: 'GatewayPaymentAttentionRaised',
      eventVersion: 1,
      tenantId: '00000000-0000-0000-0000-000000000001',
      aggregateType: 'Payment',
      aggregateId: 'p-1',
      sequence: 1,
      correlationId: 'r9',
      causationId: null,
      actor: { type: 'SYSTEM_JOB', id: null },
      occurredAt: '2026-10-25T10:00:00.000Z',
      payload: { customerId: 'c-1', orderId: null, provider: 'TONPAYS_TELEGRAM', reason },
    } as unknown as DomainEvent;
    await consumer.handle(event, {} as never);
    const one = queued[0];
    if (one === undefined) return null;
    return {
      key: one.templateKey,
      text: renderTemplateBody(
        templateDefinition(one.templateKey),
        CATALOGUE_FA[one.templateKey as never],
        one.values,
        'fa',
        DEFAULT_TEMPLATE_PRESENTATION,
      ),
    };
  }

  it('UNDERPAID, OVERPAID and CREDIT_AMOUNT_MISMATCH each have their own headline', async () => {
    const less = await render('UNDERPAID');
    expect(less?.key).toBe('ops.financial.payment_underpaid');
    expect(less?.text.split('\n')[0]).toBe('⚠️ پرداخت ناقص — منتظر مابقی');
    expect(less?.text).toContain('۱۲۰۰۰ تومان');
    const more = await render('OVERPAID');
    expect(more?.key).toBe('ops.financial.payment_overpaid');
    expect(more?.text.split('\n')[0]).toBe('⚠️ پرداخت بیش از مبلغ — منتظر کارت بازگشت');
    expect(more?.text).toContain('۱۵۰۰۰ تومان');
    const credit = await render('CREDIT_AMOUNT_MISMATCH');
    expect(credit?.key).toBe('ops.financial.credit_amount_mismatch');
    expect(credit?.text).toContain('۹۹۰۰۰ تومان');
  });
});
