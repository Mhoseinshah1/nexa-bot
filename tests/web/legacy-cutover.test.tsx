import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LegacyCutoverPage } from '../../apps/web/src/pages/legacy-cutover';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Mirza PR6 — the owner's cutover approval page. Fixtures go through the real API client
 * and the contract's schemas.
 *
 * What this file defends: the page says it imports nothing and that a changed value voids
 * an approval; the approve button stays disabled until all seven values are exact SHA-256s
 * (a pasted space or a capital letter is NOT fixed — it is sent nowhere); the body sent is
 * exactly the strict approve request; a list is walked to every page; without
 * `legacy.cutover.approve` nothing writes; the page and nav entry are gated on
 * `legacy.cutover.view`.
 */

const H = (c: string) => c.repeat(64);
const NEXT_LABEL = 'web.older' as const;
const ID = '019600ab-cdef-7012-8345-6789abcd0201';

const approval = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  kind: 'CUTOVER',
  sourceFingerprint: H('a'),
  panelMapFingerprint: H('b'),
  inventoryFingerprint: H('c'),
  productsFingerprint: H('d'),
  invoiceArchiveFingerprint: H('e'),
  freezeProofSha256: H('f'),
  finalDumpSha256: H('1'),
  priorSourceFingerprint: null,
  synthetic: false,
  reason: 'approved',
  approvedByAdminId: '019600ab-cdef-7012-8345-6789abcd0202',
  approvedAt: '2026-10-07T09:00:00.000Z',
  revocation: null,
  ...overrides,
});

const readSet = (n: number) => ({
  id: `019600ab-cdef-7012-8345-6789abcd03${String(n).padStart(2, '0')}`,
  readSet: 'inventory',
  fingerprintVersion: 'legacy-read-set:inventory:v1',
  readSetFingerprint: H(String(n % 10)),
  sourceFingerprint: H('a'),
  synthetic: false,
  tableCount: 3,
  rowCount: '10',
  recordedAt: '2026-10-07T08:00:00.000Z',
});

function page(options: { mayApprove?: boolean } = {}) {
  const api = stubApi([
    {
      url: '/legacy-cutover/approvals',
      method: 'GET',
      body: { approvals: [approval()], nextCursor: null },
    },
    {
      url: '/legacy-cutover/read-sets?after=',
      method: 'GET',
      body: { readSets: [readSet(2)], nextCursor: null },
    },
    {
      url: '/legacy-cutover/read-sets',
      method: 'GET',
      body: { readSets: [readSet(1)], nextCursor: readSet(1).id },
    },
    { url: '/legacy-cutover/apply-runs', method: 'GET', body: { runs: [], nextCursor: null } },
    { url: '/legacy-cutover/approvals', method: 'POST', body: { approval: approval() } },
    {
      url: `/legacy-cutover/approvals/${ID}/revoke`,
      method: 'POST',
      body: {
        approval: approval({
          revocation: {
            revokedByAdminId: '019600ab-cdef-7012-8345-6789abcd0202',
            revokedAt: '2026-10-07T10:00:00.000Z',
            reason: 'r',
          },
        }),
      },
    },
  ]);
  renderPage(<LegacyCutoverPage denied={false} mayApprove={options.mayApprove ?? true} />);
  return api;
}

const FIELDS: readonly [string, string][] = [
  ['web.lco_field_source', H('a')],
  ['web.lco_field_panel_map', H('b')],
  ['web.lco_field_inventory', H('c')],
  ['web.lco_field_products', H('d')],
  ['web.lco_field_invoice_archive', H('e')],
  ['web.lco_field_freeze', H('f')],
  ['web.lco_field_dump', H('1')],
];

describe('the legacy cutover approval page', () => {
  it('lists approvals and says it imports nothing', async () => {
    const api = page();
    expect(await screen.findAllByText(H('a'))).not.toHaveLength(0);
    expect(screen.getByText(t('web.lco_banner'))).toBeInTheDocument();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('approve stays disabled until every value is an exact SHA-256; the body is the strict request, verbatim', async () => {
    const api = page();
    await screen.findByText(t('web.lco_approve_title'));
    const button = screen.getByRole('button', { name: t('web.lco_approve') });
    for (const [label, value] of FIELDS) {
      fireEvent.change(screen.getByLabelText(t(label as never)), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText(t('web.lco_reason')), { target: { value: 'ok' } });
    expect(button).toBeEnabled();
    // A pasted space is not fixed: the value is refused, never trimmed.
    fireEvent.change(screen.getByLabelText(t('web.lco_field_dump')), {
      target: { value: ` ${H('1')}`.slice(0, 64) },
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lco_field_dump')), {
      target: { value: H('F') },
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lco_field_dump')), { target: { value: H('1') } });
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/legacy-cutover/approvals')),
      ).toHaveLength(1),
    );
    const sent = api.calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(
      [
        'finalDumpSha256',
        'freezeProofSha256',
        'idempotencyKey',
        'inventoryFingerprint',
        'invoiceArchiveFingerprint',
        'kind',
        'panelMapFingerprint',
        'priorSourceFingerprint',
        'productsFingerprint',
        'reason',
        'sourceFingerprint',
      ].sort(),
    );
    expect(sent).toMatchObject({
      kind: 'CUTOVER',
      priorSourceFingerprint: null,
      finalDumpSha256: H('1'),
    });
  });

  it('a re-run acknowledgement needs a prior source other than this one', async () => {
    page();
    await screen.findByText(t('web.lco_approve_title'));
    fireEvent.change(screen.getByLabelText(t('web.lco_col_kind')), {
      target: { value: 'RERUN_OVER_PRIOR_IMPORT' },
    });
    for (const [label, value] of FIELDS) {
      fireEvent.change(screen.getByLabelText(t(label as never)), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText(t('web.lco_reason')), { target: { value: 'ok' } });
    const button = screen.getByRole('button', { name: t('web.lco_approve') });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lco_field_prior')), {
      target: { value: H('a') },
    });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lco_field_prior')), {
      target: { value: H('9') },
    });
    expect(button).toBeEnabled();
  });

  it('the recorded read sets are walked to the next page', async () => {
    const api = page();
    expect(await screen.findByText(H('1'))).toBeInTheDocument();
    const next = screen.getAllByRole('button', { name: t(NEXT_LABEL) });
    expect(next.length).toBeGreaterThan(0);
    fireEvent.click(next.find((b) => !(b as HTMLButtonElement).disabled) as HTMLElement);
    await waitFor(() =>
      expect(api.calls.some((c) => c.url.includes('/legacy-cutover/read-sets?after='))).toBe(true),
    );
  });

  it('without legacy.cutover.approve nothing on the page writes', async () => {
    const api = page({ mayApprove: false });
    expect(await screen.findByText(t('web.lco_view_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lco_approve') })).toBeNull();
    expect(screen.queryByRole('button', { name: t('web.lco_revoke') })).toBeNull();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.cutover.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-cutover');
    expect(entry).toMatchObject({ permission: 'legacy.cutover.view' });
    expect(navPermitted(entry!, ['legacy.cutover.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.debts.view', 'orders.view'])).toBe(false);
    const route = { path: '/legacy-cutover', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.cutover.view']).title).toBe(t('web.lco_title'));
  });
});
