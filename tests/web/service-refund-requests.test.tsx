import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  OpenServiceRefundRequestsCard,
  ServiceRefundRequestsCard,
} from '../../apps/web/src/pages/service-refund-requests';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * WP19 — the Web Admin fallback for customers' refund requests (brief §2.10). Fixtures go
 * through the real client and are parsed by the contract's schema.
 *
 * What this file defends: the attention card shows only what still wants an operator; the
 * decision form sends the destructive confirmation only once the operator ticked it, as a
 * decimal string of minor units; and an operator without both decision keys is told so
 * rather than handed a form.
 */

const SERVICE_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const REQUEST_ID = '019250ab-cdef-7012-8345-6789abcdef01';

const request = (overrides: Record<string, unknown> = {}) => ({
  id: REQUEST_ID,
  serviceId: SERVICE_ID,
  serviceUsername: 'nx_mary',
  customerId: '019260ab-cdef-7012-8345-6789abcdef01',
  customerTelegramUserId: '910911',
  customerUsername: 'mary',
  paymentId: '019270ab-cdef-7012-8345-6789abcdef01',
  orderId: '019280ab-cdef-7012-8345-6789abcdef01',
  state: 'OPEN',
  reason: 'سرعت مناسب نبود',
  principalMinor: '250000',
  remainingMinor: '250000',
  currency: 'IRT',
  approvedAmountMinor: null,
  refundId: null,
  operationId: null,
  operationState: null,
  decidedByAdminId: null,
  decidedAt: null,
  rejectionReason: null,
  failureKind: null,
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  resolvedAt: null,
  ...overrides,
});

describe('the requests that still want an operator', () => {
  it('lists open, executing and failed requests, and not decided ones', async () => {
    const api = stubApi([
      // What an unfiltered page would be: decided rows, newest first. The card never asks
      // for it (Codex review of #83).
      {
        url: '/service-refund-requests',
        body: {
          requests: [
            request({
              id: '019250ab-cdef-7012-8345-6789abcdef05',
              state: 'COMPLETED',
              reason: 'دلیل چهارم',
            }),
            request({
              id: '019250ab-cdef-7012-8345-6789abcdef06',
              state: 'REJECTED',
              reason: 'رد',
            }),
          ],
        },
      },
      {
        url: '/service-refund-requests?state=OPEN',
        body: {
          requests: [request({ id: '019250ab-cdef-7012-8345-6789abcdef02', reason: 'دلیل اول' })],
        },
      },
      {
        url: '/service-refund-requests?state=EXECUTING',
        body: {
          requests: [
            request({
              id: '019250ab-cdef-7012-8345-6789abcdef03',
              state: 'EXECUTING',
              reason: 'دلیل دوم',
              operationState: 'UNKNOWN',
            }),
          ],
        },
      },
      {
        url: '/service-refund-requests?state=FAILED',
        body: {
          requests: [
            request({
              id: '019250ab-cdef-7012-8345-6789abcdef04',
              state: 'FAILED',
              reason: 'دلیل سوم',
            }),
          ],
        },
      },
    ]);
    renderPage(<OpenServiceRefundRequestsCard />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('دلیل اول')).toBeInTheDocument();
    expect(within(table).getByText('دلیل دوم')).toBeInTheDocument();
    expect(within(table).getByText('دلیل سوم')).toBeInTheDocument();
    expect(within(table).queryByText('دلیل چهارم')).toBeNull();
    expect(within(table).queryByText('دلیل پنجم')).toBeNull();
    // An ambiguous deletion is shown as what it is, never as progress.
    expect(within(table).getByText('UNKNOWN')).toBeInTheDocument();
    // The server filters before it limits: one read per state, never the newest page of all.
    const reads = api.calls
      .map((call) => call.url)
      .filter((url) => url.includes('/service-refund-requests'));
    expect(reads.every((url) => url.includes('?state='))).toBe(true);
    expect(reads.some((url) => url.includes('state=OPEN'))).toBe(true);
    // Each row leads to its service, where the decision is.
    expect(within(table).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      `/services/${SERVICE_ID}`,
    );
  });
});

describe('one service’s requests', () => {
  const forService = (rows: readonly Record<string, unknown>[]) => ({
    url: `/services/${SERVICE_ID}/refund-requests`,
    body: { requests: rows },
  });

  it('approves only after the destructive confirmation is ticked, with the amount as minor units', async () => {
    const api = stubApi([
      forService([request()]),
      {
        url: `/service-refund-requests/${REQUEST_ID}/approve`,
        body: { request: request({ state: 'EXECUTING', approvedAmountMinor: '120000' }) },
      },
    ]);
    renderPage(<ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide />);
    await screen.findByRole('table');

    const approve = screen.getByRole('button', { name: t('web.service_refund_approve') });
    fireEvent.change(screen.getByLabelText(t('web.service_refund_amount')), {
      target: { value: '120000' },
    });
    expect(approve, 'not without the confirmation').toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(approve).toBeEnabled();
    fireEvent.click(approve);

    await waitFor(() => {
      const call = api.calls.find((one) => one.url.endsWith('/approve'));
      expect(call?.body).toMatchObject({ amountMinor: '120000', confirm: true });
    });
  });

  it('rejects with the typed reason', async () => {
    const api = stubApi([
      forService([request()]),
      {
        url: `/service-refund-requests/${REQUEST_ID}/reject`,
        body: { request: request({ state: 'REJECTED', rejectionReason: 'خارج از بازه' }) },
      },
    ]);
    renderPage(<ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide />);
    await screen.findByRole('table');
    const reject = screen.getByRole('button', { name: t('web.service_refund_reject') });
    expect(reject, 'not without a reason').toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.service_refund_reject_reason')), {
      target: { value: 'خارج از بازه' },
    });
    fireEvent.click(reject);
    await waitFor(() => {
      const call = api.calls.find((one) => one.url.endsWith('/reject'));
      expect(call?.body).toMatchObject({ reason: 'خارج از بازه' });
    });
  });

  it('tells an operator without both decision keys so, and draws no form', async () => {
    stubApi([forService([request()])]);
    renderPage(<ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide={false} />);
    await screen.findByRole('table');
    expect(screen.getByText(t('web.service_refund_denied'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.service_refund_approve') })).toBeNull();
  });

  it('offers no decision on a request that is no longer open', async () => {
    stubApi([forService([request({ state: 'EXECUTING', approvedAmountMinor: '100000' })])]);
    renderPage(<ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide />);
    await screen.findByRole('table');
    expect(screen.queryByRole('button', { name: t('web.service_refund_approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.service_refund_reject') })).toBeNull();
  });
});
