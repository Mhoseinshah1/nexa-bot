import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LegacyDebtsPage } from '../../apps/web/src/pages/legacy-debts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Mirza PR4 — the legacy wallet debts page (owner decision 6). Fixtures go through the real
 * API client and the contract's schemas.
 *
 * What this file defends: the page says the debt is never collected and that a decision
 * moves no money; a decision sends exactly the strict decide body (no amount) bound to the
 * version shown; without `legacy.debts.decide` nothing writes; the page and its nav entry
 * are gated on `legacy.debts.view` (MEDIUM: an observer does not see it).
 */

const ID = '019600ab-cdef-7012-8345-6789abcd0101';

const debt = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  customerId: '019600ab-cdef-7012-8345-6789abcd0102',
  legacyUserId: '100000003',
  amountMinor: '20000',
  currency: 'IRT',
  state: 'PENDING_REVIEW',
  sourceFingerprint: 'b'.repeat(64),
  rowChecksum: 'c'.repeat(64),
  runId: '019600ab-cdef-7012-8345-6789abcd0199',
  synthetic: false,
  decisionReason: null,
  decidedByAdminId: null,
  decidedAt: null,
  version: 1,
  recordedAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  ...overrides,
});

const summary = {
  currency: 'IRT',
  total: { count: 1, sumMinor: '20000' },
  byState: {
    PENDING_REVIEW: { count: 1, sumMinor: '20000' },
    ACKNOWLEDGED: { count: 0, sumMinor: '0' },
    WAIVED: { count: 0, sumMinor: '0' },
  },
};

function page(options: { mayDecide?: boolean; row?: Record<string, unknown> } = {}) {
  const api = stubApi([
    { url: '/legacy-debts', method: 'GET', body: { debts: [debt(options.row)], nextCursor: null } },
    { url: '/legacy-debts/summary', method: 'GET', body: summary },
    {
      url: `/legacy-debts/${ID}/decide`,
      method: 'POST',
      body: { debt: debt({ state: 'WAIVED', version: 2, decisionReason: 'r' }) },
    },
    {
      url: `/legacy-debts/${ID}/reopen`,
      method: 'POST',
      body: { debt: debt({ version: 3 }) },
    },
  ]);
  renderPage(<LegacyDebtsPage denied={false} mayDecide={options.mayDecide ?? true} />);
  return api;
}

describe('the legacy wallet debts page', () => {
  it('lists the debts pending review and says they are never collected', async () => {
    const api = page();
    expect(await screen.findByText('100000003')).toBeInTheDocument();
    expect(screen.getByText(t('web.lwd_banner'))).toBeInTheDocument();
    expect(await screen.findByText(t('web.lwd_summary_title'))).toBeInTheDocument();
    await waitFor(() =>
      expect(
        api.calls.some((c) => c.method === 'GET' && c.url.includes('state=PENDING_REVIEW')),
      ).toBe(true),
    );
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a decision sends the strict body bound to the version shown — never an amount', async () => {
    const api = page();
    fireEvent.click(await screen.findByRole('button', { name: t('web.lwd_open') }));
    expect(await screen.findByText(t('web.lwd_decision_moves_no_money'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lwd_never_collected'))).toBeInTheDocument();
    const waive = screen.getByRole('button', { name: t('web.lwd_waive') });
    expect(waive).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lwd_reason')), {
      target: { value: 'بخشیده شد' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.lwd_waive') }));
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === 'POST' && c.url.includes('/decide')),
      ).toHaveLength(1),
    );
    const sent = api.calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'decision',
      'expectedVersion',
      'idempotencyKey',
      'reason',
    ]);
    expect(sent).toMatchObject({ decision: 'WAIVED', expectedVersion: 1, reason: 'بخشیده شد' });
  });

  it('a decided debt offers only a reopen', async () => {
    page({
      row: {
        state: 'ACKNOWLEDGED',
        version: 2,
        decidedAt: '2026-10-07T10:00:00.000Z',
        decidedByAdminId: '019600ab-cdef-7012-8345-6789abcd0103',
        decisionReason: 'ok',
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lwd_open') }));
    expect(await screen.findByRole('button', { name: t('web.lwd_reopen') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lwd_waive') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.lwd_acknowledge') })).toBeNull();
  });

  it('without legacy.debts.decide nothing on the page writes', async () => {
    const api = page({ mayDecide: false });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lwd_open') }));
    expect(await screen.findByText(t('web.lwd_view_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lwd_waive') })).toBeNull();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.debts.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-debts');
    expect(entry).toMatchObject({ permission: 'legacy.debts.view', group: 'web.navgroup_sales' });
    expect(navPermitted(entry!, ['legacy.debts.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.invoices.view', 'orders.view'])).toBe(false);
    const route = { path: '/legacy-debts', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.debts.view']).title).toBe(t('web.lwd_title'));
  });
});
