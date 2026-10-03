import { describe, expect, it } from 'vitest';
import type { PaymentId } from '@nexa/contracts';
import { gatewayProviderFacts } from '../../apps/api/src/modules/commerce/payments/application/financial-log.consumer';
import type { GatewayInvoiceRecord } from '../../apps/api/src/modules/commerce/payments/application/gateway-invoice-ports';

/**
 * The financial log's provider facts for a NOWPayments attempt (Codex review of #141): the
 * amount labelled as the provider's is what the provider's own read REPORTED, and a price
 * that differs from the invoiced one is shown beside it — never the invoiced price alone.
 */

const PAYMENT_ID = '01a0fa00-0000-7000-8000-000000000001' as PaymentId;
const CREATED_AT = new Date('2026-10-02T10:00:00Z');

function invoice(overrides: Partial<GatewayInvoiceRecord> = {}): GatewayInvoiceRecord {
  return {
    paymentId: PAYMENT_ID,
    provider: 'NOWPAYMENTS',
    providerOrderId: 'NTAAAAAAAAAAAAAAAAAA',
    providerInvoiceId: 'NP-INV',
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
    invoiceUrl: 'https://nowpayments.io/payment/?iid=4522625843',
    webInvoiceUrl: null,
    providerUnit: 'USD',
    sentAmount: 1000n,
    conversionRateMinor: null,
    conversionPolicy: 'CENTRAL_FX',
    fx: null,
    botInstanceId: null,
    providerChargeId: null,
    requestAmount: 250_000n,
    finalAmount: 250_037n,
    creditAmount: null,
    providerStatus: 'pending',
    providerPaid: false,
    lastInquiryAt: null,
    lastInquiryErrorCode: null,
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
    cardNumber: null,
    cardName: null,
    cardSeq: null,
    cardReceivedAt: null,
    cardChangeShown: null,
    cardChangeCooldownUntil: null,
    cardChangeExhausted: null,
    reconcileInquiryRequestedAt: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

describe('the financial log’s NOWPayments provider facts', () => {
  it('shows the reported price, and the invoiced one beside it when they differ', () => {
    expect(gatewayProviderFacts(invoice({ requestAmount: 1000n, hintedPaymentId: '77' }))).toEqual({
      providerInvoiceId: 'NP-INV/77',
      providerFinalAmount: '10.00 USD',
    });
    expect(gatewayProviderFacts(invoice({ requestAmount: 999n }))).toEqual({
      providerInvoiceId: 'NP-INV',
      providerFinalAmount: '9.99 USD ≠ 10.00 USD',
    });
    expect(gatewayProviderFacts(invoice({ requestAmount: null })).providerFinalAmount).toBe('—');
  });
});

/**
 * CentralPay (`docs/centralpay-gateway-audit.md` §5.4): the Toman the provider's verify
 * REPORTED, the invoiced figure beside it when they differ, and the bound reference.
 */
describe('the financial log’s CentralPay provider facts', () => {
  const centralpay = (overrides: Partial<GatewayInvoiceRecord>) =>
    invoice({
      provider: 'CENTRALPAY',
      providerOrderId: '1234567890',
      providerInvoiceId: '1234567890',
      providerUserId: '1987654321',
      providerUnit: 'IRT',
      sentAmount: 150_000n,
      conversionPolicy: 'SAME_UNIT',
      finalAmount: null,
      ...overrides,
    });
  it('shows the verified Toman and the reference, and a mismatch beside the invoiced figure', () => {
    expect(
      gatewayProviderFacts(centralpay({ requestAmount: 150_000n, providerChargeId: 'REF-1' })),
    ).toEqual({
      providerInvoiceId: '1234567890/ref:REF-1',
      providerFinalAmount: '150000 IRT',
    });
    expect(gatewayProviderFacts(centralpay({ requestAmount: 149_999n }))).toEqual({
      providerInvoiceId: '1234567890',
      providerFinalAmount: '149999 IRT ≠ 150000 IRT',
    });
    expect(gatewayProviderFacts(centralpay({ requestAmount: null })).providerFinalAmount).toBe('—');
  });
});
