import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import {
  COUNTER_CAP,
  PAYMENT_OPS_QUEUES,
  navCountersResponseSchema,
  paymentAttentionResponseSchema,
  systemDiagnosticsResponseSchema,
  type NavCountersResponse,
  type PermissionKey,
} from '@nexa/contracts';
import { dashboardAttentionItems } from '../../apps/web/src/attention-view';
import { DashboardPage } from '../../apps/web/src/pages/dashboard';
import {
  ATTENTION_PERMISSIONS,
  AttentionQueueCard,
} from '../../apps/web/src/pages/dashboard-attention';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/**
 * Roadmap B6 — the attention-first dashboard: the queue of what waits for a person, first
 * on the page, every row a server count from an existing source and a link to the page that
 * handles it. Every fixture is parsed by the contract's schema.
 */

const ALL_NULL: NavCountersResponse['counters'] = {
  openConditions: null,
  ticketsAwaitingSupport: null,
  unhealthyPanels: null,
  unreconciledServices: null,
  refundRequestsAwaiting: null,
  paymentsUnknown: null,
  businessHandoffs: null,
};

const counters = (values: Partial<NavCountersResponse['counters']> = {}) =>
  navCountersResponseSchema.parse({
    generatedAt: '2026-10-07T10:00:00.000Z',
    counters: { ...ALL_NULL, ...values },
  });

const diagnostics = (
  counts: Partial<Record<'UNKNOWN_OUTCOME' | 'LEASE_EXPIRED' | 'RETRYING' | 'UNANNOUNCED', number>>,
  exhausted = 0,
) =>
  systemDiagnosticsResponseSchema.parse({
    generatedAt: '2026-10-07T10:00:00.000Z',
    outbox: {
      pending: exhausted,
      oldestPendingAt: null,
      failing: exhausted,
      exhausted,
      failingSample: [],
    },
    provisioning: {
      counts: { UNKNOWN_OUTCOME: 0, LEASE_EXPIRED: 0, RETRYING: 0, UNANNOUNCED: 0, ...counts },
      sample: [],
    },
  });

const paymentAttention = (reconcilable: number) =>
  paymentAttentionResponseSchema.parse({
    window: null,
    byGateway: [],
    totals: {
      ...Object.fromEntries(PAYMENT_OPS_QUEUES.map((queue) => [queue, 0])),
      // Facets that are not "waiting for a person now" never become rows.
      MISMATCH: 7,
      PROVIDER_ERROR: 3,
      PENDING: 40,
      NEEDS_RECONCILIATION: reconcilable,
    },
    generatedAt: '2026-10-07T10:00:00.000Z',
  });

const FULL = counters({
  openConditions: 1,
  ticketsAwaitingSupport: 5,
  unhealthyPanels: 2,
  unreconciledServices: 3,
  refundRequestsAwaiting: 1,
  paymentsUnknown: 4,
  businessHandoffs: 6,
});

const EVERYTHING: readonly PermissionKey[] = ATTENTION_PERMISSIONS;

const routes = (
  nav = FULL,
  diag: unknown = diagnostics({ LEASE_EXPIRED: 1, UNANNOUNCED: 2, UNKNOWN_OUTCOME: 1 }, 2),
  pay: unknown = paymentAttention(2),
) => [
  { url: '/nav-counters', body: nav },
  { url: '/system/diagnostics', body: diag },
  { url: '/payment-operations/attention', body: pay },
];

const queue = () => screen.findByRole('list', { name: t('web.dash_attn_title') });
const hrefs = (list: HTMLElement) =>
  within(list)
    .getAllByRole('link')
    .map((link) => link.getAttribute('href'));

describe('the attention queue', () => {
  it('lists what waits, loudest first, each linked to the page that handles it', async () => {
    stubApi(routes());
    renderPage(<AttentionQueueCard permissions={EVERYTHING} />);
    const list = await queue();
    await waitFor(() => expect(within(list).getAllByRole('link')).toHaveLength(11));
    expect(hrefs(list)).toEqual([
      '/system?section=diagnostics',
      '/system?section=diagnostics',
      '/system?section=diagnostics',
      '/services?state=UNRECONCILED',
      '/panel-health',
      '/payments?queue=UNKNOWN',
      '/payments?queue=NEEDS_RECONCILIATION',
      '/services',
      '/business-chats?state=HANDOFF_REQUIRED',
      '/tickets',
      '/alerts',
    ]);
    // Stalled = LEASE_EXPIRED + UNANNOUNCED (disjoint reasons): 3.
    const stuck = within(list).getByText(t('web.dash_attn_stuck_operations')).closest('a');
    expect(stuck?.textContent).toContain('3');
    expect(within(list).getByText(t('web.dash_attn_handoffs'))).toBeTruthy();
  });

  it('asks no source the viewer may not read, and draws no row it withheld', async () => {
    const api = stubApi(routes(counters({ ticketsAwaitingSupport: 2, businessHandoffs: 1 })));
    renderPage(
      <AttentionQueueCard permissions={['tickets.view', 'business_chats.view', 'users.view']} />,
    );
    const list = await queue();
    expect(hrefs(list)).toEqual(['/business-chats?state=HANDOFF_REQUIRED', '/tickets']);
    // `opslog.view` and `payments.view` are not held: neither source was asked, so no 403
    // is recorded on every poll.
    expect(api.calls.some((call) => call.url.includes('/system/diagnostics'))).toBe(false);
    expect(api.calls.some((call) => call.url.includes('/payment-operations'))).toBe(false);
  });

  it('is not drawn, and asks nothing, for a viewer who holds no permission any row needs', async () => {
    const api = stubApi(routes());
    const { container } = renderPage(<AttentionQueueCard permissions={['users.view']} />);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(container.textContent).toBe('');
    expect(api.calls).toHaveLength(0);
  });

  it('says the queue is empty only when every source asked has answered', async () => {
    stubApi(
      routes(
        counters({
          openConditions: 0,
          ticketsAwaitingSupport: 0,
          unhealthyPanels: 0,
          unreconciledServices: 0,
          refundRequestsAwaiting: 0,
          paymentsUnknown: 0,
          businessHandoffs: 0,
        }),
        diagnostics({}),
        paymentAttention(0),
      ),
    );
    renderPage(<AttentionQueueCard permissions={EVERYTHING} />);
    await screen.findByText(t('web.dash_attn_clear'));
  });

  it('never claims an empty queue over a source that failed', async () => {
    stubApi([
      { url: '/nav-counters', body: counters({ openConditions: 0 }) },
      // The diagnostics read failed: its rows are unknown, not zero.
      { url: '/system/diagnostics', body: { error: 'boom' }, status: 500 },
      { url: '/payment-operations/attention', body: paymentAttention(0) },
    ]);
    renderPage(<AttentionQueueCard permissions={EVERYTHING} />);
    await screen.findByText(t('web.dash_attn_partial'));
    expect(screen.queryByText(t('web.dash_attn_clear'))).toBeNull();
    expect(screen.getByRole('button', { name: t('web.retry') })).toBeTruthy();
  });

  it('stands first on the dashboard, before any business or fleet figure', async () => {
    stubApi([
      ...routes(),
      {
        url: '/system/readiness',
        body: { status: 'ok', dependencies: [{ name: 'postgres', status: 'up' }] },
      },
      { url: '/ops-log', body: { events: [], nextCursor: null } },
    ]);
    const { container } = renderPage(<DashboardPage permissions={EVERYTHING} />);
    await queue();
    const cards = [...container.querySelectorAll('section.card')];
    expect(cards[0]?.id).toBe('dash-attention');
  });
});

describe('the attention queue’s rules', () => {
  it('draws no row for a zero, a withheld count or a source not asked', () => {
    expect(dashboardAttentionItems({})).toEqual([]);
    expect(
      dashboardAttentionItems({ counters: counters({ paymentsUnknown: 0 }).counters }),
    ).toEqual([]);
    expect(dashboardAttentionItems({ counters: ALL_NULL })).toEqual([]);
  });

  it('marks a capped counter as a floor, and an exact count never', () => {
    const items = dashboardAttentionItems({
      counters: counters({ ticketsAwaitingSupport: COUNTER_CAP, paymentsUnknown: 3 }).counters,
      payments: paymentAttention(COUNTER_CAP + 5),
    });
    const by = (key: string) => items.find((item) => item.key === key);
    expect(by('ticketsAwaitingSupport')?.atLeast).toBe(true);
    expect(by('paymentsUnknown')?.atLeast).toBe(false);
    // The payment queue counts are exact (no cap), so no floor however large.
    expect(by('paymentsReconcilable')).toMatchObject({ count: COUNTER_CAP + 5, atLeast: false });
  });

  it('counts only what waits for a person now, never a payment facet that is history', () => {
    const items = dashboardAttentionItems({ payments: paymentAttention(0) });
    expect(items).toEqual([]);
  });

  it('counts a retrying operation as in motion, not stuck', () => {
    const items = dashboardAttentionItems({ diagnostics: diagnostics({ RETRYING: 9 }) });
    expect(items).toEqual([]);
  });

  it('gives every row a tone that matches its urgency', () => {
    const items = dashboardAttentionItems({
      counters: FULL.counters,
      diagnostics: diagnostics({ LEASE_EXPIRED: 1, UNKNOWN_OUTCOME: 1 }, 1),
      payments: paymentAttention(1),
    });
    const tones = Object.fromEntries(items.map((item) => [item.key, item.tone]));
    expect(tones).toEqual({
      stuckOperations: 'danger',
      unknownOperations: 'danger',
      outboxExhausted: 'danger',
      unreconciledServices: 'danger',
      unhealthyPanels: 'danger',
      paymentsUnknown: 'warn',
      paymentsReconcilable: 'warn',
      refundRequests: 'warn',
      businessHandoffs: 'warn',
      ticketsAwaitingSupport: 'info',
      openConditions: 'warn',
    });
  });

  it('is drawn under every counter’s permission, the diagnostics’ and the payment queues’', () => {
    expect([...ATTENTION_PERMISSIONS].sort()).toEqual(
      [
        'business_chats.view',
        'opslog.view',
        'panels.view',
        'payments.view',
        'refunds.view',
        'services.view',
        'tickets.view',
      ].sort(),
    );
  });
});
