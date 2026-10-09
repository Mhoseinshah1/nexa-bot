import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { PaymentDetailPage } from '../../apps/web/src/pages/payments';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * FIX-02 (2026-10-09) on the Web Admin: the payment detail shows the payment's PUBLIC
 * tracking code — the one on every invoice the customer saw — and copies that, never the
 * stored `<code>:topup` reference whose suffix is an operational key.
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef02';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef02';

function detail(reference: string): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: null,
    state: 'PENDING',
    method: 'MANUAL_TRANSFER',
    amount: '250000',
    currency: 'IRT',
    reference,
    evidenceKind: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: null,
    expiresAt: null,
    createdAt: '2026-10-09T08:00:00.000Z',
    updatedAt: '2026-10-09T08:00:00.000Z',
    gatewayProvider: 'MANUAL_TRANSFER',
    evidenceNote: null,
    resolutionNote: null,
    destination: null,
  };
}

const routes = (reference: string) => [
  { url: `/payments/${ROW_ID}`, body: { payment: detail(reference) } },
  {
    url: `/payments/${ROW_ID}/timeline`,
    body: { paymentId: ROW_ID, entries: [], withheld: [], truncated: false },
  },
];

const page = () => (
  <PaymentDetailPage
    id={ROW_ID}
    mayViewReceipts={false}
    mayViewRefunds={false}
    mayIssueRefunds={false}
    denied={false}
  />
);

describe('FIX-02: the payment’s public tracking code on the Web Admin', () => {
  it.each([':topup', ':manual', ':gateway', ':gateway-topup', ':wallet'])(
    'shows and copies the code, never the stored reference with %s',
    async (suffix) => {
      stubApi(routes(`7d433a363380f69e${suffix}`));
      renderPage(page());
      await screen.findAllByText('7d433a363380f69e');
      const text = document.body.textContent ?? '';
      expect(text).not.toContain(suffix);
      const copied = [...document.querySelectorAll('[data-copy-value]')].map((node) =>
        node.getAttribute('data-copy-value'),
      );
      // The title's copy button copies the code a customer quotes.
      expect(copied).toContain('7d433a363380f69e');
      expect(copied.join(' ')).not.toContain(suffix);
    },
  );

  it('shows a reference of any other shape exactly as stored (backward compatibility)', async () => {
    stubApi(routes('LEGACY-REF-1'));
    renderPage(page());
    expect((await screen.findAllByText('LEGACY-REF-1')).length).toBeGreaterThan(0);
  });

  it('labels the column with the exact words', () => {
    expect(t('web.payment_reference')).toBe('کد پیگیری پرداخت');
  });
});
