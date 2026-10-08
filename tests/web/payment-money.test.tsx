import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { PaymentDetailPage } from '../../apps/web/src/pages/payments';
import { formatMoneyText } from '../../apps/web/src/format';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap E3, E4, E5 on the Web Admin (`docs/refund-audit.md`, `docs/payment-fees-fx.md`).
 * Fixtures go through the real client and are parsed by the contract schemas.
 *
 * What this file defends: the money card renders the SERVER's figures and computes nothing
 * (a fixture whose figures do not add up is shown exactly as sent); merchant net is said to
 * be unrecorded, never derived; the rate provenance names its authority and evidence; and a
 * payment that cannot be refunded says WHY, by the server's reason, with no control.
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

function detail(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    state: 'CONFIRMED',
    method: 'GATEWAY',
    amount: '250000',
    currency: 'IRT',
    reference: 'money-ref-0001',
    evidenceKind: 'GATEWAY_INQUIRY',
    confirmedAt: '2026-10-07T09:00:00.000Z',
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: null,
    expiresAt: null,
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-07T09:00:00.000Z',
    gatewayProvider: 'NOWPAYMENTS',
    evidenceNote: null,
    resolutionNote: null,
    destination: null,
    amounts: {
      currency: 'IRT',
      principal: '250000',
      customerFee: '6250',
      customerFeeBasisPoints: 250,
      // Deliberately NOT principal + fee: the page must show what the server said.
      payable: '777777',
      received: '777777',
      walletCredit: '0',
      walletDebit: '0',
      merchantNet: null,
      merchantNetReason: 'NOT_RECORDED',
    },
    ...over,
  };
}

const routes = (over: Record<string, unknown> = {}, ledger: Record<string, unknown> = {}) => [
  { url: `/payments/${ROW_ID}`, body: { payment: detail(over) } },
  {
    url: `/payments/${ROW_ID}/timeline`,
    body: { paymentId: ROW_ID, entries: [], withheld: [], truncated: false },
  },
  {
    url: `/payments/${ROW_ID}/refunds`,
    body: {
      refunds: [],
      paidMinor: '250000',
      consumedMinor: '0',
      refundableMinor: '250000',
      currency: 'IRT',
      refundable: false,
      refusalReason: 'CHANNEL_UNSUPPORTED',
      ...ledger,
    },
  },
];

const page = (mayIssue = true) => (
  <PaymentDetailPage
    id={ROW_ID}
    mayViewReceipts={false}
    mayViewRefunds
    mayIssueRefunds={mayIssue}
    denied={false}
  />
);

describe('the payment’s money on the Web Admin', () => {
  it('renders the server’s breakdown as sent, computing nothing', async () => {
    stubApi(routes());
    renderPage(page());
    await screen.findByText(t('web.payment_amounts'));
    // `Money` splits the figure and its unit into elements; the figure's own text is read.
    const figure = (minor: string) =>
      formatMoneyText({ amountMinor: minor, currency: 'IRT' }).split(' ')[0] as string;
    const text = document.body.textContent ?? '';
    expect(text.split(figure('777777')).length - 1).toBeGreaterThanOrEqual(2);
    // The sum the browser could have computed is nowhere on the page.
    expect(text).not.toContain(figure('256250'));
    expect(screen.getByText(t('web.payment_amounts_merchant_net_not_recorded'))).toBeTruthy();
    // The figure is labelled what it is — what the customer was asked to pay — and no
    // refund figure stands beside it: the refund ledger is the one answer (PR #247 F1, F4).
    expect(screen.getByText(t('web.payment_customer_fee_payable'))).toBeTruthy();
    expect(text).not.toContain('سقف');
  });

  it('names the rate’s authority and its evidence from the attempt’s snapshot', async () => {
    stubApi(
      routes({
        gatewayInvoice: {
          provider: 'NOWPAYMENTS',
          providerOrderId: '4000000001',
          providerInvoiceId: 'np-1',
          creationState: 'CREATED',
          creationErrorCode: null,
          providerStatus: 'finished',
          providerPaid: true,
          lastInquiryAt: null,
          lastInquiryErrorCode: null,
          webhookStatusHint: null,
          lastWebhookAt: null,
          webhookCount: 0,
          providerUnit: 'USD',
          sentAmount: '10',
          conversionRateMinor: null,
          conversionPolicy: 'CENTRAL_FX',
          providerChargeId: null,
          requestAmount: null,
          finalAmount: null,
          creditAmount: null,
          outcome: null,
          lateCompletionObservedAt: null,
          createdAt: '2026-10-07T08:00:00.000Z',
          rateProvenance: {
            authority: 'MARKET',
            policy: 'CENTRAL_FX',
            rate: '103500.0000',
            source: 'NOBITEX',
            quoteId: 'v1:NOBITEX:USDTIRT:q-77',
            policyVersion: 1,
            quotedAt: '2026-10-07T07:59:58.000Z',
            fetchedAt: '2026-10-07T07:59:59.000Z',
            quoteState: 'FRESH',
            frozenAt: '2026-10-07T08:00:00.000Z',
          },
        },
      }),
    );
    renderPage(page());
    await screen.findByText(t('web.payment_rate_provenance'));
    expect(screen.getByText(t('web.payment_rate_authority_market'))).toBeTruthy();
    expect(screen.getByText('NOBITEX')).toBeTruthy();
    expect(screen.getByText('v1:NOBITEX:USDTIRT:q-77')).toBeTruthy();
    expect(screen.getByText('FRESH')).toBeTruthy();
    // The rate is grouped like every other figure, exactly, with no trailing zeros.
    expect(screen.getByText('103,500')).toBeTruthy();
    expect(document.body.textContent).not.toContain('103500.0000');
  });

  it('says why a payment cannot be refunded, by the server’s reason, and offers nothing', async () => {
    stubApi(routes());
    renderPage(page());
    expect(await screen.findByText(t('web.refund_refusal_channel_unsupported'))).toBeTruthy();
    expect(screen.queryByText(t('web.refund_unavailable'))).toBeNull();
    expect(screen.queryByRole('button', { name: 'ثبت درخواست' })).toBeNull();
  });

  it('names a top-up’s reason distinctly from a gateway’s', async () => {
    stubApi(
      routes(
        { orderId: null, method: 'MANUAL_TRANSFER' },
        { refusalReason: 'TOPUP_CREDITED_TO_WALLET' },
      ),
    );
    renderPage(page());
    expect(await screen.findByText(t('web.refund_refusal_topup'))).toBeTruthy();
  });

  it('falls back to the general sentence for a ledger from before reasons existed', async () => {
    stubApi(routes({}, { refusalReason: undefined }));
    renderPage(page());
    expect(await screen.findByText(t('web.refund_unavailable'))).toBeTruthy();
  });
});
