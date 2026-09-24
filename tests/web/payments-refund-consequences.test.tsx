import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { PaymentDetailPage } from '../../apps/web/src/pages/payments';
import { order, renderPage, stubApi } from './harness';

/**
 * The refund consequences, on the Web Admin (WP10 §10-A P3, kept by Payment File 02 D8).
 *
 * `docs/wp10-payments-audit.md` P3 is the design. Every fixture goes through the real API
 * client and is parsed by the contract's schemas, so a fixture that drifted from what the
 * server sends fails here rather than in production.
 *
 * What this file defends: a refund refused for `DELIVERY_IN_PROGRESS` says so, and a
 * refunded order is said to be REFUNDED — from the ORDER — with the service explicitly
 * untouched. (The late-review lane this file also covered was withdrawn by Payment File
 * 02 §9 and removed with it; `docs/payments-file02-design.md` D1.)
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

function payment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: ORDER_ID,
    state: 'CONFIRMED',
    method: 'MANUAL_TRANSFER',
    amount: '250000',
    currency: 'IRT',
    reference: 'a1b2c3d4e5f60718:manual',
    evidenceKind: 'OPERATOR_REVIEW',
    confirmedAt: '2026-09-10T13:00:00.000Z',
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: '2026-09-10T12:45:00.000Z',
    expiresAt: '2026-09-10T13:30:00.000Z',
    createdAt: '2026-09-10T12:30:00.000Z',
    updatedAt: '2026-09-10T13:00:00.000Z',
    ...overrides,
  };
}

const detail = (overrides: Record<string, unknown> = {}) => [
  {
    url: `/payments/${ROW_ID}`,
    body: {
      payment: {
        ...payment(overrides),
        evidenceNote: null,
        resolutionNote: null,
        destination: null,
      },
    },
  },
];

const refusal = (code: string, details: Record<string, unknown> = {}) => ({
  error: { kind: 'conflict', code, message: 'refused', details, correlationId: 'test' },
});

// ---------------------------------------------------------------------------
// Refunds: the delivery refusal, and what a full refund did and did not do (P3)
// ---------------------------------------------------------------------------

describe('the refund consequences', () => {
  const confirmed = { state: 'CONFIRMED', resolvedAt: null };
  const ledger = (overrides: Record<string, unknown> = {}) => ({
    url: `/payments/${ROW_ID}/refunds`,
    body: {
      refunds: [],
      paidMinor: '250000',
      consumedMinor: '0',
      refundableMinor: '250000',
      currency: 'IRT',
      refundable: true,
      ...overrides,
    },
  });

  const refundPage = (mayViewOrders: boolean) => (
    <PaymentDetailPage
      id={ROW_ID}
      mayViewReceipts={false}
      mayViewRefunds
      mayIssueRefunds
      mayViewOrders={mayViewOrders}
      denied={false}
    />
  );

  it('names DELIVERY_IN_PROGRESS when the server refuses a refund for it', async () => {
    stubApi([
      ...detail(confirmed),
      ledger(),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
    ]);
    /*
     * The ledger GET and the refund POST share a URL, so the refusal is routed by method —
     * and every ledger read AFTER it answers `refundable: false`, which is what the server
     * says while the delivery is undecided. The sentence must survive that re-read.
     */
    const original = globalThis.fetch;
    let refused = false;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/refunds') && init?.method !== 'POST' && refused) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              refunds: [],
              paidMinor: '250000',
              consumedMinor: '0',
              refundableMinor: '250000',
              currency: 'IRT',
              refundable: false,
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (String(input).endsWith('/refunds') && init?.method === 'POST') {
        refused = true;
        return Promise.resolve(
          new Response(
            JSON.stringify(
              refusal('commerce.refund_not_permitted', { reason: 'DELIVERY_IN_PROGRESS' }),
            ),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    renderPage(refundPage(true));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '100000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    expect(
      await screen.findByText(/تا وقتی ساخت سرویس این سفارش به نتیجهٔ قطعی نرسیده/u),
    ).toBeInTheDocument();
    // The ledger was re-read and now says unrefundable: the form is gone, the reason stays.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'ثبت درخواست' })).toBeNull();
    });
    expect(
      screen.getByText(/تا وقتی ساخت سرویس این سفارش به نتیجهٔ قطعی نرسیده/u),
    ).toBeInTheDocument();
  });

  it('keeps the server’s own message for a refusal that is not about delivery', async () => {
    stubApi([...detail(confirmed), ledger()]);
    const original = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      if (String(input).endsWith('/refunds') && init?.method === 'POST') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: {
                kind: 'conflict',
                code: 'commerce.refund_not_permitted',
                message: 'This payment has refunds in another currency.',
                details: { reason: 'CURRENCY_MISMATCH' },
                correlationId: 'test',
              },
            }),
            { status: 409, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      return original(input as RequestInfo, init);
    }) as typeof fetch;
    renderPage(refundPage(false));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    fireEvent.change(screen.getByLabelText('مبلغ (به کوچک‌ترین یکای پول)'), {
      target: { value: '100000' },
    });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مشتری منصرف شد' } });
    fireEvent.click(screen.getByRole('button', { name: 'ثبت درخواست' }));

    expect(
      await screen.findByText('This payment has refunds in another currency.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/تا وقتی ساخت سرویس این سفارش/u)).toBeNull();
  });

  it('says the order is REFUNDED, from the order, and that the service was not touched', async () => {
    const api = stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '250000', refundableMinor: '0' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'REFUNDED' }) } },
    ]);
    const view = renderPage(refundPage(true));

    expect(await screen.findByText('سفارش این پرداخت بازگشت خورده است')).toBeInTheDocument();
    const text = view.container.textContent ?? '';
    expect(text).toContain('بازگشت وجه هیچ سرویسی را تعلیق یا حذف نمی‌کند');
    // It READ the order rather than inferring the state from the refund rows.
    expect(api.calls.some((call) => call.url.endsWith(`/orders/${ORDER_ID}`))).toBe(true);
    // And points at the order, where its service is shown and acted on.
    const link = screen.getByRole('link', { name: 'مشاهدهٔ سفارش و سرویس آن' });
    expect(link.getAttribute('href')).toBe(`/orders/${ORDER_ID}`);
  });

  it('says nothing about the order while it is still PAID', async () => {
    stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '100000', refundableMinor: '150000' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'PAID' }) } },
    ]);
    const view = renderPage(refundPage(true));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');
    // Let the order query settle before asserting its absence.
    await waitFor(() => {
      expect(view.container.textContent).toContain('ثبت بازگشت وجه');
    });
    expect(view.container.textContent).not.toContain('سفارش این پرداخت بازگشت خورده است');
  });

  it('neither asks for nor describes the order without orders.view', async () => {
    const api = stubApi([
      ...detail(confirmed),
      ledger({ consumedMinor: '250000', refundableMinor: '0' }),
      { url: `/orders/${ORDER_ID}`, body: { order: order({ state: 'REFUNDED' }) } },
    ]);
    const view = renderPage(refundPage(false));
    await screen.findByText('باقی‌ماندهٔ قابل بازگشت');

    expect(api.calls.some((call) => call.url.includes('/orders/'))).toBe(false);
    expect(view.container.textContent).not.toContain('سفارش این پرداخت بازگشت خورده است');
  });
});
