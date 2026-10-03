import { describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PAYMENT_OPS_QUEUES, type PaymentAttentionResponse } from '@nexa/contracts';
import { PaymentsPage, queueCountsFor } from '../../apps/web/src/pages/payments';
import { PaymentTimelineCard } from '../../apps/web/src/pages/payment-timeline';
import { resolve } from '../../apps/web/src/app';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * The Payment Operations Center in the Web Admin (program §10). Fixtures go through the real
 * client and are parsed by the contract schemas, so a fixture that drifted from the wire
 * fails here.
 *
 * What this file defends: the queue chips show the SERVER's counts (never a count of the
 * rows on screen); a queue, a route and a range are sent as the list's own parameters; the
 * one command on the page is "ask again", drawn only for an UNKNOWN gateway payment and only
 * with `payments.reconcile`; and nothing on the page marks a payment paid.
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

function counts(overrides: Partial<Record<(typeof PAYMENT_OPS_QUEUES)[number], number>> = {}) {
  return {
    ...Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
    ...overrides,
  } as PaymentAttentionResponse['totals'];
}

const ATTENTION: PaymentAttentionResponse = {
  window: null,
  byGateway: [
    { gatewayProvider: 'NOWPAYMENTS', counts: counts({ UNKNOWN: 3, MISMATCH: 2, PARTIAL: 1 }) },
    { gatewayProvider: 'TONPAYS', counts: counts({ PENDING: 4, UNKNOWN: 1 }) },
  ],
  totals: counts({ PENDING: 4, UNKNOWN: 4, MISMATCH: 2, PARTIAL: 1 }),
  generatedAt: '2026-10-03T09:00:00.000Z',
};

function gatewayRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: null,
    state: 'UNKNOWN',
    method: 'GATEWAY',
    amount: '1035000',
    currency: 'IRT',
    reference: 'np-ref-0001',
    evidenceKind: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: null,
    expiresAt: null,
    createdAt: '2026-10-03T08:00:00.000Z',
    updatedAt: '2026-10-03T08:10:00.000Z',
    gatewayProvider: 'NOWPAYMENTS',
    gatewaySignal: {
      creationState: 'CREATED',
      creationErrorCode: null,
      providerStatus: 'partially_paid',
      providerPaid: false,
      lastInquiryAt: '2026-10-03T08:10:00.000Z',
      lastInquiryErrorCode: null,
      outcome: null,
      lateCompletionObservedAt: null,
      reconcileInquiryRequestedAt: null,
    },
    ...overrides,
  };
}

const routes = (rows: unknown[], attention: unknown = ATTENTION) => [
  { url: '/payments', body: { payments: rows, nextCursor: null } },
  { url: '/payment-operations/attention', body: attention },
];

const routeOf = (query: Record<string, string> = {}) => ({
  path: '/payments',
  query: new URLSearchParams(query),
});

describe('the Payment Operations Center', () => {
  it('shows each queue with the server’s count, and the selected route’s counts when one is chosen', async () => {
    stubApi(routes([gatewayRow()]));
    renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('np-ref-0001');
    const group = screen.getByRole('group', { name: t('web.payment_ops_queue') });
    const unknown = await within(group).findByRole('button', {
      name: new RegExp(t('web.payment_ops_queue_unknown')),
    });
    await waitFor(() => expect(unknown.textContent).toContain('4'));

    expect(queueCountsFor(ATTENTION, 'NOWPAYMENTS')).toMatchObject({ UNKNOWN: 3, PENDING: 0 });
    // A route the server returned no row for has nothing in any queue — not "unknown".
    expect(queueCountsFor(ATTENTION, 'CENTRALPAY')).toEqual(counts());
    expect(queueCountsFor(undefined, null)).toBeNull();
  });

  it('sends the queue, the route and the range as the list’s own parameters, and the range to the counts', async () => {
    const api = stubApi(routes([gatewayRow()]));
    renderPage(
      <PaymentsPage
        route={routeOf({ queue: 'MISMATCH', gateway: 'NOWPAYMENTS', range: 'LAST_7_DAYS' })}
        denied={false}
      />,
    );
    await screen.findByText('np-ref-0001');
    const list = api.calls.find((call) => call.url.includes('/payments?'))?.url ?? '';
    expect(list).toContain('queue=MISMATCH');
    expect(list).toContain('gateway=NOWPAYMENTS');
    expect(list).toContain('range=LAST_7_DAYS');
    const attention = api.calls.find((call) => call.url.includes('/payment-operations/attention'));
    expect(attention?.url).toContain('range=LAST_7_DAYS');
    // The queue's meaning is said, not left to guess.
    expect(screen.getByText(t('web.payment_ops_queue_hint_mismatch'))).toBeTruthy();
  });

  it('ignores a queue, route or range the contract does not name, rather than sending it', async () => {
    const api = stubApi(routes([gatewayRow()]));
    renderPage(
      <PaymentsPage
        route={routeOf({ queue: 'FORCE_PAID', gateway: 'PAYPAL', range: 'FOREVER' })}
        denied={false}
      />,
    );
    await screen.findByText('np-ref-0001');
    const list = api.calls.find((call) => call.url.includes('/payments'))?.url ?? '';
    expect(list).not.toContain('queue=');
    expect(list).not.toContain('gateway=');
    expect(list).not.toContain('range=');
  });

  it('shows what the gateway last said on the row, by code', async () => {
    stubApi(
      routes([
        gatewayRow({
          gatewaySignal: {
            creationState: 'CREATE_UNKNOWN',
            creationErrorCode: 'TIMEOUT',
            providerStatus: null,
            providerPaid: null,
            lastInquiryAt: null,
            lastInquiryErrorCode: 'HTTP_503',
            outcome: 'LATE_COMPLETION',
            lateCompletionObservedAt: '2026-10-03T08:20:00.000Z',
            reconcileInquiryRequestedAt: null,
          },
        }),
      ]),
    );
    const { container } = renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('np-ref-0001');
    expect(container.textContent).toContain('CREATE_UNKNOWN');
    expect(container.textContent).toContain('HTTP_503');
  });

  it('draws "ask again" only for an UNKNOWN gateway payment and only with payments.reconcile — and it sends the existing command with a key', async () => {
    const api = stubApi([
      ...routes([gatewayRow()]),
      { url: `/payments/${ROW_ID}/reinquire`, body: { requested: true } },
    ]);
    const { unmount } = renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('np-ref-0001');
    expect(screen.queryByRole('button', { name: t('web.payment_reinquire') })).toBeNull();
    unmount();

    renderPage(<PaymentsPage route={routeOf()} denied={false} mayReconcile />);
    await screen.findByText('np-ref-0001');
    fireEvent.click(screen.getByRole('button', { name: t('web.payment_reinquire') }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('/reinquire'))).toBe(true),
    );
    const sent = api.calls.find((call) => call.url.includes('/reinquire'));
    expect(sent?.method).toBe('POST');
    expect((sent?.body as { idempotencyKey?: string }).idempotencyKey).toMatch(/.{8,}/u);
  });

  it('draws no "ask again" on a PENDING or a settled payment, and no control that marks one paid', async () => {
    stubApi(
      routes([
        gatewayRow({ state: 'PENDING' }),
        gatewayRow({
          id: '019240ab-cdef-7012-8345-6789abcdef02',
          reference: 'np-ref-0002',
          state: 'CONFIRMED',
          evidenceKind: 'GATEWAY_CALLBACK',
          confirmedAt: '2026-10-03T08:05:00.000Z',
        }),
      ]),
    );
    renderPage(<PaymentsPage route={routeOf()} denied={false} mayReconcile />);
    await screen.findByText('np-ref-0002');
    expect(screen.queryByRole('button', { name: t('web.payment_reinquire') })).toBeNull();
    for (const button of screen.getAllByRole('button')) {
      expect(button.textContent ?? '').not.toMatch(/پرداخت‌شده|تأیید پرداخت/u);
    }
    expect(document.body.textContent).toContain(t('web.payment_ops_no_force_paid'));
  });

  it('wires the route: the list is the workspace, with ask-again under payments.reconcile', () => {
    const resolved = resolve(routeOf(), ['payments.view', 'payments.reconcile']);
    expect(resolved.title).toBe(t('web.payment_ops_title'));
    expect((resolved.element as ReactElement<{ mayReconcile?: boolean }>).props.mayReconcile).toBe(
      true,
    );
    const viewer = resolve(routeOf(), ['payments.view']);
    expect((viewer.element as ReactElement<{ mayReconcile?: boolean }>).props.mayReconcile).toBe(
      false,
    );
  });
});

describe('the payment history’s operations entries', () => {
  const PAYMENT_ID = ROW_ID;
  const ORDER_ID = '019230ab-cdef-7012-8345-6789abcdef01';

  it('renders the gateway, order and audit entries by code, and names the ORDER and AUDIT sections it withheld', async () => {
    stubApi([
      {
        url: `/payments/${PAYMENT_ID}/timeline`,
        body: {
          paymentId: PAYMENT_ID,
          entries: [
            {
              kind: 'GATEWAY_INVOICE_REQUESTED',
              at: '2026-10-03T08:00:00.000Z',
              provider: 'NOWPAYMENTS',
              creationState: 'CREATED',
              errorCode: null,
            },
            {
              kind: 'GATEWAY_WEBHOOK_HINT',
              at: '2026-10-03T08:05:00.000Z',
              provider: 'NOWPAYMENTS',
              statusHint: 'partially_paid',
              webhookCount: 3,
            },
            {
              kind: 'GATEWAY_INQUIRY',
              at: '2026-10-03T08:06:00.000Z',
              provider: 'NOWPAYMENTS',
              providerStatus: 'partially_paid',
              providerPaid: false,
              errorCode: null,
            },
            {
              kind: 'PAYMENT_OUTCOME_UNKNOWN',
              at: '2026-10-03T08:06:00.000Z',
              reason: 'PROVIDER_AMOUNT_MISMATCH',
              providerStatus: 'partially_paid',
            },
            {
              kind: 'ORDER_FULFILMENT',
              at: '2026-10-03T08:30:00.000Z',
              orderId: ORDER_ID,
              operationType: 'PROVISION',
              operationState: 'SUCCEEDED',
            },
          ],
          withheld: ['ORDER', 'AUDIT'],
          truncated: false,
        },
      },
    ]);
    const { container } = renderPage(
      <PaymentTimelineCard paymentId={PAYMENT_ID} paymentState="UNKNOWN" />,
    );
    await screen.findByText(t('web.payment_timeline_outcome_unknown'));
    expect(container.textContent).toContain('PROVIDER_AMOUNT_MISMATCH');
    expect(container.textContent).toContain(t('web.payment_timeline_webhook'));
    expect(container.textContent).toContain('3');
    expect(container.textContent).toContain(t('web.payment_timeline_withheld_order'));
    expect(container.textContent).toContain(t('web.payment_timeline_withheld_audit'));
    const link = container.querySelector(`a[href="/orders/${ORDER_ID}"]`);
    expect(link).not.toBeNull();
  });
});
