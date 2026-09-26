import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { PaymentTimelineCard } from '../../apps/web/src/pages/payment-timeline';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The payment history card (WP17 D2). Fixtures go through the real client and are parsed
 * by `paymentTimelineResponseSchema`, so a fixture that drifted from the wire fails here.
 *
 * What this file defends: rows are rendered in the SERVER's order (never re-sorted), a
 * withheld section is named, a truncated history says so, and the card has no control.
 */

const PAYMENT_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ADMIN_ID = '019250ab-cdef-7012-8345-6789abcdef01';

const timeline = (overrides: Record<string, unknown> = {}) => [
  {
    url: `/payments/${PAYMENT_ID}/timeline`,
    body: {
      paymentId: PAYMENT_ID,
      entries: [
        {
          kind: 'PAYMENT_CREATED',
          at: '2026-09-10T12:30:00.000Z',
          method: 'MANUAL_TRANSFER',
          amountMinor: '250000',
          currency: 'IRT',
        },
        {
          kind: 'PAYMENT_RESOLVED',
          at: '2026-09-10T13:00:00.000Z',
          state: 'FAILED',
          adminId: ADMIN_ID,
        },
        // Deliberately EARLIER than the row above: the server's order is the order.
        {
          kind: 'CUSTOMER_NOTIFIED',
          at: '2026-09-10T12:59:00.000Z',
          notificationKind: 'PAYMENT_REJECTED',
          deliveryState: 'DELIVERED',
          resolvedAt: '2026-09-10T13:00:05.000Z',
        },
      ],
      withheld: [],
      truncated: false,
      ...overrides,
    },
  },
];

function rows(): string[] {
  const table = screen.getByRole('table');
  return within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[1]?.textContent ?? '');
}

describe('payment timeline card', () => {
  it('renders the entries in the order the server gave, with no control', async () => {
    stubApi(timeline());
    const { container } = renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} />);

    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
    expect(rows()).toEqual([
      t('web.payment_timeline_created'),
      t('web.payment_timeline_resolved'),
      t('web.payment_timeline_notified'),
    ]);
    expect(
      screen.getByText(t('web.payment_timeline_delivery_delivered'), { exact: false }),
    ).toBeInTheDocument();
    // The only buttons are the copy buttons beside an administrator id; nothing acts.
    const buttons = [...container.querySelectorAll('button')];
    expect(buttons.length).toBeGreaterThan(0);
    expect(buttons.every((b) => b.getAttribute('aria-label') === t('web.copy'))).toBe(true);
    expect(screen.queryByText(t('web.payment_timeline_withheld'), { exact: false })).toBeNull();
    expect(screen.queryByText(t('web.payment_timeline_truncated'))).toBeNull();
  });

  it('names every section it was not allowed to show', async () => {
    stubApi(timeline({ withheld: ['REFUNDS', 'WALLET'] }));
    renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} />);

    const banner = await screen.findByText(t('web.payment_timeline_withheld'), { exact: false });
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_refunds'));
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_wallet'));
    expect(banner.textContent).not.toContain(t('web.payment_timeline_withheld_receipts'));
  });

  it('says a truncated history is truncated', async () => {
    stubApi(timeline({ truncated: true }));
    renderPage(<PaymentTimelineCard paymentId={PAYMENT_ID} />);

    expect(await screen.findByText(t('web.payment_timeline_truncated'))).toBeInTheDocument();
  });
});
