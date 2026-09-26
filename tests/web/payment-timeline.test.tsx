import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import { resolve } from '../../apps/web/src/app';
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

/**
 * The card in its page, through the real route.
 *
 * The receipts section is decided by the SERVER (`receipts.view`, withheld and named in
 * the response), so what the page must get right is to ask only once the payment itself
 * has been read, and to say which sections were withheld — receipts included — rather
 * than draw a history that looks complete.
 */
describe('payment timeline card on the payment detail', () => {
  const detailRoute = {
    url: `/payments/${PAYMENT_ID}`,
    body: {
      payment: {
        id: PAYMENT_ID,
        customerId: '019210ab-cdef-7012-8345-6789abcdef01',
        orderId: null,
        state: 'PENDING',
        method: 'MANUAL_TRANSFER',
        amount: '250000',
        currency: 'IRT',
        reference: 'a1b2c3d4e5f60718:manual',
        evidenceKind: null,
        confirmedAt: null,
        confirmedByAdminId: null,
        resolvedAt: null,
        resolvedByAdminId: null,
        customerSignalledAt: null,
        expiresAt: null,
        createdAt: '2026-09-10T12:30:00.000Z',
        updatedAt: '2026-09-10T12:30:00.000Z',
        evidenceNote: null,
        resolutionNote: null,
        destination: null,
      },
    },
  };

  const open = (permissions: readonly string[]) =>
    renderPage(
      resolve({ path: `/payments/${PAYMENT_ID}`, query: new URLSearchParams() }, permissions)
        .element as ReactElement,
    );

  const timelineCalls = (calls: readonly { url: string }[]) =>
    calls.filter((call) => call.url.includes('/timeline'));

  it('names the receipts section when a viewer without receipts.view is refused it', async () => {
    const api = stubApi([
      detailRoute,
      ...timeline({ withheld: ['RECEIPTS', 'REFUNDS', 'WALLET'] }),
    ]);
    open(['payments.view']);

    const banner = await screen.findByText(t('web.payment_timeline_withheld'), { exact: false });
    expect(banner.textContent).toContain(t('web.payment_timeline_withheld_receipts'));
    // And the page's own receipts card is neither drawn nor asked for.
    expect(api.calls.some((call) => call.url.includes('/receipts'))).toBe(false);
    expect(timelineCalls(api.calls)).toHaveLength(1);
  });

  it('asks for no history while the payment itself could not be read', async () => {
    const api = stubApi([
      {
        ...detailRoute,
        status: 500,
        body: {
          error: { kind: 'internal', code: 'test.boom', message: 'boom', correlationId: 'test' },
        },
      },
      ...timeline(),
    ]);
    const { container } = open(['payments.view', 'receipts.view']);

    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith(`/payments/${PAYMENT_ID}`))).toBe(true),
    );
    // The page has settled into its error state before the absence is asserted.
    expect(await screen.findByRole('button', { name: t('web.retry') })).toBeInTheDocument();
    expect(timelineCalls(api.calls)).toHaveLength(0);
    expect(container.textContent).not.toContain(t('web.payment_timeline'));
  });

  it('draws no history for a viewer without payments.view', () => {
    const api = stubApi([detailRoute, ...timeline()]);
    const { container } = open(['receipts.view']);

    expect(api.calls).toHaveLength(0);
    expect(container.textContent).not.toContain(t('web.payment_timeline'));
  });
});
