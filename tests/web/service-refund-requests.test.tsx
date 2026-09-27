import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  OpenServiceRefundRequestsCard,
  ServiceRefundRequestsCard,
} from '../../apps/web/src/pages/service-refund-requests';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import type { ReactElement } from 'react';
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
          nextCursor: null,
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
      // The server's one stream over the three states that want an operator.
      {
        url: '/service-refund-requests?attention=true',
        body: {
          nextCursor: null,
          requests: [
            request({ id: '019250ab-cdef-7012-8345-6789abcdef02', reason: 'دلیل اول' }),
            request({
              id: '019250ab-cdef-7012-8345-6789abcdef03',
              state: 'EXECUTING',
              reason: 'دلیل دوم',
              operationState: 'UNKNOWN',
            }),
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
    // The server filters before it limits, never the newest page of all; and as ONE stream,
    // never a scan per state that could miss a request moving between two of them (Codex
    // review of #83, round 6).
    const reads = api.calls
      .map((call) => call.url)
      .filter((url) => url.includes('/service-refund-requests'));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('?attention=true');
    expect(reads.some((url) => url.includes('state='))).toBe(false);
    // Each row leads to its service, where the decision is.
    expect(within(table).getAllByRole('link')[0]?.getAttribute('href')).toBe(
      `/services/${SERVICE_ID}`,
    );
  });
});

describe('a finance reviewer holding refunds.view alone (Codex review of #83, round 5)', () => {
  it('reaches the queue from the navigation, and never asks for the services list', async () => {
    const services = NAV.find((entry) => entry.id === 'services');
    expect(navPermitted(services!, ['refunds.view'])).toBe(true);
    const api = stubApi([
      {
        url: '/service-refund-requests?attention=true',
        body: {
          nextCursor: null,
          requests: [request({ id: '019250ab-cdef-7012-8345-6789abcdef09', reason: 'فقط مالی' })],
        },
      },
    ]);
    const resolved = resolve({ path: '/services', query: new URLSearchParams() }, ['refunds.view']);
    renderPage(resolved.element as ReactElement);
    expect(await screen.findByText('فقط مالی')).toBeInTheDocument();
    // The list is still the services list's: denied, and never fetched.
    expect(api.calls.some((call) => /\/services(\?|$)/.test(call.url))).toBe(false);
  });
});

describe('the attention card’s paging', () => {
  it('reads one page of the stream, and the next only when asked, by the server’s cursor (Codex review of #83, rounds 6 and 9)', async () => {
    const oldest = '019250ab-cdef-7012-8345-6789abcdef09';
    const api = stubApi([
      {
        url: '/service-refund-requests?attention=true',
        body: {
          requests: [request({ id: '019250ab-cdef-7012-8345-6789abcdef08', reason: 'تازه' })],
          nextCursor: {
            at: '2026-09-20T10:00:00.000Z',
            id: '019250ab-cdef-7012-8345-6789abcdef08',
          },
        },
      },
      {
        url: '/service-refund-requests?attention=true&before=',
        body: {
          requests: [
            request({
              id: oldest,
              state: 'FAILED',
              reason: 'قدیمی‌ترین',
              createdAt: '2026-09-01T10:00:00.000Z',
            }),
          ],
          nextCursor: null,
        },
      },
    ]);
    renderPage(<OpenServiceRefundRequestsCard />);
    const first = await screen.findByRole('table');
    expect(within(first).getByText('تازه')).toBeInTheDocument();
    // One page on arrival: a failure history is not drained on every visit (round 9).
    expect(within(first).queryByText('قدیمی‌ترین')).not.toBeInTheDocument();
    expect(api.calls.filter((call) => call.url.includes('before='))).toHaveLength(0);
    expect(screen.getByRole('button', { name: t('web.newer') })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: t('web.older') }));
    await waitFor(() =>
      expect(within(screen.getByRole('table')).getByText('قدیمی‌ترین')).toBeInTheDocument(),
    );
    // The second read names the first page's cursor, both halves, in the same stream.
    const second = api.calls.find((call) => call.url.includes('before='));
    expect(second?.url).toContain('attention=true');
    expect(second?.url).toContain('beforeId=019250ab-cdef-7012-8345-6789abcdef08');
    expect(screen.getByRole('button', { name: t('web.older') })).toBeDisabled();
  });
});

describe('one service’s requests', () => {
  const forService = (rows: readonly Record<string, unknown>[]) => ({
    url: `/services/${SERVICE_ID}/refund-requests`,
    body: { requests: rows, nextCursor: null },
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

  it('never says "deletion started" for a replayed approval whose deletion already ended (Codex review of #83, round 7)', async () => {
    for (const [state, key] of [
      ['FAILED', 'web.service_refund_failed_toast'],
      ['COMPLETED', 'web.service_refund_completed_toast'],
      ['EXECUTING', 'web.service_refund_approved_toast'],
    ] as const) {
      const view = stubApi([
        forService([request()]),
        {
          url: `/service-refund-requests/${REQUEST_ID}/approve`,
          body: { request: request({ state, approvedAmountMinor: '120000' }) },
        },
      ]);
      const { unmount } = renderPage(
        <ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide />,
      );
      await screen.findByRole('table');
      fireEvent.change(screen.getByLabelText(t('web.service_refund_amount')), {
        target: { value: '120000' },
      });
      fireEvent.click(screen.getByRole('checkbox'));
      fireEvent.click(screen.getByRole('button', { name: t('web.service_refund_approve') }));
      expect(await screen.findByText(t(key)), state).toBeInTheDocument();
      if (state !== 'EXECUTING') {
        expect(screen.queryByText(t('web.service_refund_approved_toast')), state).toBeNull();
      }
      expect(view.calls.some((call) => call.url.endsWith('/approve'))).toBe(true);
      unmount();
    }
  });

  it('accepts a reason of 300 emoji, counted in code points (Codex review of #83, round 8)', async () => {
    const reason = '😀'.repeat(300); // 600 UTF-16 units
    const api = stubApi([
      forService([request()]),
      {
        url: `/service-refund-requests/${REQUEST_ID}/reject`,
        body: { request: request({ state: 'REJECTED', rejectionReason: reason }) },
      },
    ]);
    renderPage(<ServiceRefundRequestsCard serviceId={SERVICE_ID} mayDecide />);
    await screen.findByRole('table');
    fireEvent.change(screen.getByLabelText(t('web.service_refund_reject_reason')), {
      target: { value: reason },
    });
    const reject = screen.getByRole('button', { name: t('web.service_refund_reject') });
    expect(reject).toBeEnabled();
    fireEvent.click(reject);
    await waitFor(() => {
      const call = api.calls.find((one) => one.url.endsWith('/reject'));
      expect((call?.body as { reason: string } | undefined)?.reason).toBe(reason);
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
