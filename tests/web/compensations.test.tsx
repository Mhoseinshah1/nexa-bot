import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { CompensationsPage } from '../../apps/web/src/pages/compensations';
import { formatTimestamp } from '../../apps/web/src/format';
import { renderPage, stubApi } from './harness';

/**
 * The compensation list (Payment File 02 §21, D7): every automatic wallet refund of an
 * order that could not be delivered. Rendered through the real client and the real
 * `compensationListResponseSchema`, so a fixture that drifted from the contract fails
 * here. Read-only: no action, and no timeline.
 */

const PAYMENT_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';
const REFUND_ID = '019270ab-cdef-7012-8345-6789abcdef01';

function compensation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    refundId: REFUND_ID,
    paymentId: PAYMENT_ID,
    orderId: ORDER_ID,
    customerId: CUSTOMER_ID,
    customerTelegramUserId: '5550004321',
    customerUsername: 'reza_buyer',
    principalMinor: '250000',
    creditedMinor: '250000',
    currency: 'IRT',
    reason: 'UNDELIVERABLE',
    state: 'COMPLETED',
    createdAt: '2026-09-12T10:00:00.000Z',
    completedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  };
}

const ROUTE = { path: '/compensations', query: new URLSearchParams() };

describe('the compensation list', () => {
  it('shows payment, order, customer, principal, amount credited, reason, state and time', async () => {
    stubApi([
      { url: '/compensations', body: { compensations: [compensation()], nextCursor: null } },
    ]);
    const view = renderPage(<CompensationsPage route={ROUTE} denied={false} />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText(PAYMENT_ID.slice(0, 8)).closest('a')).toHaveAttribute(
      'href',
      `/payments/${PAYMENT_ID}`,
    );
    expect(within(table).getByText(ORDER_ID.slice(0, 8)).closest('a')).toHaveAttribute(
      'href',
      `/orders/${ORDER_ID}`,
    );
    expect(within(table).getByText('5550004321')).toBeInTheDocument();
    expect(within(table).getByText('@reza_buyer')).toBeInTheDocument();
    expect(within(table).getAllByText(/۲۵۰٬۰۰۰|250,000/u)).toHaveLength(2);
    expect(within(table).getByText('تحویل‌نشدنی')).toBeInTheDocument();
    expect(within(table).getByText('بازگشت انجام شد')).toBeInTheDocument();
    expect(table.textContent).toContain(formatTimestamp('2026-09-12T10:00:00.000Z'));
    // No action and no timeline: the only controls are the pager's.
    const labels = [...view.container.querySelectorAll('button')]
      .map((b) => b.textContent?.trim())
      .filter((label) => label !== '');
    for (const label of labels) {
      expect(
        ['قدیمی‌تر', 'تازه‌تر'],
        `a control on the compensation list: ${label ?? ''}`,
      ).toContain(label);
    }
  });

  it('pages by the server’s keyset cursor, and passes it back as it was given', async () => {
    const api = stubApi([
      {
        url: '/compensations',
        body: { compensations: [compensation()], nextCursor: 'opaque-next-token' },
      },
    ]);
    renderPage(
      <CompensationsPage
        route={{ path: '/compensations', query: new URLSearchParams('cursor=opaque-token') }}
        denied={false}
      />,
    );
    await screen.findByRole('table');
    expect(api.calls.some((call) => call.url.includes('/compensations?cursor=opaque-token'))).toBe(
      true,
    );
  });

  it('says there is nothing yet, rather than drawing an empty table', async () => {
    stubApi([{ url: '/compensations', body: { compensations: [], nextCursor: null } }]);
    renderPage(<CompensationsPage route={ROUTE} denied={false} />);
    expect(await screen.findByText('هنوز جبرانی ثبت نشده است.')).toBeInTheDocument();
  });

  it('is reached under payments with payments.view, and asks nothing without it', async () => {
    const entry = NAV.find((one) => one.id === 'compensations');
    if (entry === undefined) throw new Error('no compensations nav entry');
    expect(entry.path).toBe('/compensations');
    expect(navPermitted(entry, ['payments.view'])).toBe(true);
    expect(navPermitted(entry, ['refunds.view'])).toBe(false);
    // Directly after the payments entry, which is what it is a view of.
    const index = NAV.findIndex((one) => one.id === 'payments');
    expect(NAV[index + 1]?.id).toBe('compensations');

    const api = stubApi([
      { url: '/compensations', body: { compensations: [compensation()], nextCursor: null } },
    ]);
    const denied = resolve(ROUTE, []);
    renderPage(denied.element as ReactElement);
    await waitFor(() => {
      expect(api.calls.some((call) => call.url.includes('/compensations'))).toBe(false);
    });

    const allowed = resolve(ROUTE, ['payments.view']);
    renderPage(allowed.element as ReactElement);
    expect(await screen.findByText('@reza_buyer')).toBeInTheDocument();
  });

  it('moves to the next page by the cursor the server handed back', async () => {
    stubApi([
      {
        url: '/compensations',
        body: { compensations: [compensation()], nextCursor: 'opaque-next-token' },
      },
    ]);
    renderPage(<CompensationsPage route={ROUTE} denied={false} />);
    await screen.findByRole('table');
    const next = screen.getByRole('button', { name: 'قدیمی‌تر' });
    expect(next).toBeEnabled();
    fireEvent.click(next);
    await waitFor(() => {
      expect(window.location.search).toContain('cursor=opaque-next-token');
    });
  });
});
