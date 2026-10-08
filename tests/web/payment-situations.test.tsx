import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import { PAYMENT_OPS_QUEUES, type PaymentAttentionResponse } from '@nexa/contracts';
import { PaymentDetailPage, PaymentsPage } from '../../apps/web/src/pages/payments';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap E1/E2 — the situation guide on the Web Admin (`docs/payments-under-review-ux.md`).
 * Fixtures go through the real client and are parsed by the contract schemas.
 *
 * What this file defends: the page RENDERS the server's situation and never classifies (a
 * row whose state would suggest something else still shows what the server said); the
 * guidance card says what happened, whether money probably moved, what the customer should
 * do, which existing actions apply and what is safe; NEEDS_ACTION is the first chip, with
 * the server's count; and nothing offers to mark a payment paid.
 */

const ROW_ID = '019240ab-cdef-7012-8345-6789abcdef01';
const CUSTOMER_ID = '019210ab-cdef-7012-8345-6789abcdef01';

const counts = (over: Partial<Record<(typeof PAYMENT_OPS_QUEUES)[number], number>> = {}) =>
  ({
    ...Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
    ...over,
  }) as PaymentAttentionResponse['totals'];

const ATTENTION: PaymentAttentionResponse = {
  window: null,
  byGateway: [{ gatewayProvider: 'TONPAYS', counts: counts({ UNKNOWN: 2, NEEDS_ACTION: 7 }) }],
  totals: counts({ UNKNOWN: 2, NEEDS_ACTION: 7 }),
  generatedAt: '2026-10-07T09:00:00.000Z',
};

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: ROW_ID,
    customerId: CUSTOMER_ID,
    orderId: null,
    state: 'UNKNOWN',
    method: 'GATEWAY',
    amount: '250000',
    currency: 'IRT',
    reference: 'sit-ref-0001',
    evidenceKind: null,
    confirmedAt: null,
    confirmedByAdminId: null,
    resolvedAt: null,
    resolvedByAdminId: null,
    customerSignalledAt: null,
    expiresAt: null,
    createdAt: '2026-10-07T08:00:00.000Z',
    updatedAt: '2026-10-07T08:10:00.000Z',
    gatewayProvider: 'TONPAYS',
    situation: {
      situation: 'OUTCOME_UNKNOWN',
      money: 'POSSIBLY',
      customer: 'WAIT_DO_NOT_PAY_AGAIN',
      actions: ['ASK_PROVIDER_AGAIN', 'RECONCILE'],
      needsAction: true,
    },
    queues: ['UNKNOWN', 'NEEDS_ACTION'],
    ...over,
  };
}

const listRoutes = (rows: unknown[]) => [
  { url: '/payments', body: { payments: rows, nextCursor: null } },
  { url: '/payment-operations/attention', body: ATTENTION },
];

const detailRoutes = (over: Record<string, unknown> = {}) => [
  {
    url: `/payments/${ROW_ID}`,
    body: {
      payment: { ...row(over), evidenceNote: null, resolutionNote: null, destination: null },
    },
  },
  {
    url: `/payments/${ROW_ID}/timeline`,
    body: { paymentId: ROW_ID, entries: [], withheld: [], truncated: false },
  },
];

const routeOf = (query: Record<string, string> = {}) => ({
  path: '/payments',
  query: new URLSearchParams(query),
});

describe('the payment situation guide', () => {
  it('shows the server’s situation on the row, beside the state and never instead of it', async () => {
    stubApi(listRoutes([row()]));
    renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('sit-ref-0001');
    expect(screen.getByText(t('web.payment_situation_outcome_unknown'))).toBeTruthy();
    expect(screen.getAllByText(t('web.payment_state_unknown')).length).toBeGreaterThan(0);
  });

  it('renders what the server said even where the state would suggest otherwise — it never classifies', async () => {
    // A CONFIRMED row the server called a refund in progress: the page says so, because the
    // refunds are a fact the page does not hold.
    stubApi(
      listRoutes([
        row({
          state: 'CONFIRMED',
          confirmedAt: '2026-10-07T08:05:00.000Z',
          evidenceKind: 'WALLET_DEBIT',
          method: 'WALLET',
          gatewayProvider: null,
          situation: {
            situation: 'REFUND_IN_PROGRESS',
            money: 'RETURNING',
            customer: 'NOTHING',
            actions: ['SETTLE_REFUND'],
            needsAction: true,
          },
        }),
      ]),
    );
    renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('sit-ref-0001');
    expect(screen.getByText(t('web.payment_situation_refund_in_progress'))).toBeTruthy();
    expect(screen.queryByText(t('web.payment_situation_confirmed'))).toBeNull();
  });

  it('shows a dash for a response from before situations existed', async () => {
    const legacy = row();
    delete legacy['situation'];
    delete legacy['queues'];
    stubApi(listRoutes([legacy]));
    renderPage(<PaymentsPage route={routeOf()} denied={false} />);
    await screen.findByText('sit-ref-0001');
    expect(screen.queryByText(t('web.payment_situation_outcome_unknown'))).toBeNull();
  });

  it('leads the chips with NEEDS_ACTION, carrying the server’s count, and explains it when chosen', async () => {
    const api = stubApi(listRoutes([row()]));
    renderPage(<PaymentsPage route={routeOf({ queue: 'NEEDS_ACTION' })} denied={false} />);
    await screen.findByText('sit-ref-0001');
    const group = screen.getByRole('group', { name: t('web.payment_ops_queue') });
    const chips = within(group).getAllByRole('button');
    // "All" first, then the attention queue.
    expect(chips[1]?.textContent).toContain(t('web.payment_ops_queue_needs_action'));
    expect(await within(group).findByText('7')).toBeTruthy();
    expect(screen.getByText(t('web.payment_ops_queue_hint_needs_action'))).toBeTruthy();
    const list = api.calls.find((call) => call.url.includes('/payments?'))?.url ?? '';
    expect(list).toContain('queue=NEEDS_ACTION');
  });

  it('says on the detail what happened, whether money moved, what the customer should do, what exists and what is safe', async () => {
    stubApi(detailRoutes());
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText(t('web.payment_situation_card'));
    expect(screen.getByText(t('web.payment_situation_what_outcome_unknown'))).toBeTruthy();
    expect(screen.getByText(t('web.payment_money_possibly'))).toBeTruthy();
    expect(screen.getByText(t('web.payment_customer_guidance_wait_do_not_pay_again'))).toBeTruthy();
    expect(screen.getByText(t('web.payment_operator_action_ask_provider_again'))).toBeTruthy();
    expect(screen.getByText(t('web.payment_operator_action_reconcile'))).toBeTruthy();
    expect(screen.getByText(t('web.payment_situation_safe_outcome_unknown'))).toBeTruthy();
    expect(screen.getAllByText(t('web.payment_situation_needs_action')).length).toBeGreaterThan(0);
    // No control on the page claims to mark the payment paid.
    expect(screen.queryByRole('button', { name: /paid|پرداخت‌شده/u })).toBeNull();
  });

  it('flags the wallet adjustment for late money as undecided policy', async () => {
    stubApi(
      detailRoutes({
        state: 'EXPIRED',
        resolvedAt: '2026-10-07T09:10:00.000Z',
        situation: {
          situation: 'LATE_COMPLETION',
          money: 'AT_PROVIDER',
          customer: 'WAIT_DO_NOT_PAY_AGAIN',
          actions: ['VERIFY_AT_PROVIDER', 'MANUAL_WALLET_ADJUSTMENT'],
          needsAction: true,
        },
      }),
    );
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText(t('web.payment_situation_what_late_completion'));
    expect(screen.getByText(t('web.payment_money_at_provider'))).toBeTruthy();
    expect(
      screen.getByText(t('web.payment_operator_action_manual_wallet_adjustment')),
    ).toBeTruthy();
    expect(screen.getByText(t('web.payment_situation_safe_late_completion'))).toBeTruthy();
  });

  it('says no action is needed where none is', async () => {
    stubApi(
      detailRoutes({
        state: 'EXPIRED',
        resolvedAt: '2026-10-07T09:10:00.000Z',
        situation: {
          situation: 'EXPIRED',
          money: 'NO',
          customer: 'MAY_PAY_AGAIN',
          actions: [],
          needsAction: false,
        },
        queues: [],
      }),
    );
    renderPage(
      <PaymentDetailPage
        id={ROW_ID}
        mayViewReceipts={false}
        mayViewRefunds={false}
        mayIssueRefunds={false}
        denied={false}
      />,
    );
    await screen.findByText(t('web.payment_situation_what_expired'));
    expect(screen.getByText(t('web.payment_situation_no_action'))).toBeTruthy();
    expect(screen.queryByText(t('web.payment_situation_needs_action'))).toBeNull();
  });
});
