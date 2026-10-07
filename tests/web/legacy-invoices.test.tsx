import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { LegacyInvoicesPage, NO_FILTERS, queryOf } from '../../apps/web/src/pages/legacy-invoices';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Mirza PR3 — the legacy invoice archive page. Fixtures go through the real API client and
 * the contract's schemas.
 *
 * What this file defends: the page is READ-ONLY (no write request is ever sent, and no
 * button writes); the historical price is labelled history; personal cells are shown as
 * hidden to a reader without `legacy.invoices.pii.view`, whose search-by-PII fields are
 * disabled and never sent; every filter reaches the query; the detail shows the raw cells,
 * the revisions and the provenance; the page and its nav entry are gated on
 * `legacy.invoices.view` (MEDIUM: an observer does not see it).
 */

const ID = '019600ab-cdef-7012-8345-6789abcd0001';
const HASH = 'a'.repeat(64);

const row = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  invoiceKey: 'ab000001',
  revision: 2,
  revisionReason: 'ROW_CHANGED',
  keyShapeEvidenced: true,
  classification: 'NO_PANEL',
  live: true,
  status: 'active',
  isTest: false,
  ownerPresent: true,
  piiRedacted: false,
  legacyUserId: '100000001',
  username: 'svc_archive',
  panelCode: null,
  productCode: 'p404',
  productRef: 'NOT_IN_PRODUCT_TABLE',
  productName: 'synthetic',
  priceRaw: '150000',
  priceMinor: '150000',
  priceCurrency: 'IRT',
  priceNote: null,
  soldAtRaw: '1700000000',
  soldAt: '2023-11-14T22:13:20.000Z',
  soldAtNote: null,
  rowChecksum: HASH,
  sourceFingerprint: 'b'.repeat(64),
  readSetFingerprint: 'c'.repeat(64),
  runId: '019600ab-cdef-7012-8345-6789abcd0099',
  archivedAt: '2026-10-07T09:00:00.000Z',
  ...overrides,
});

const redacted = () => row({ piiRedacted: true, legacyUserId: null, username: null });

const summary = {
  invoices: 1,
  revisions: 2,
  classes: {
    KEY_SHAPE_UNRECOGNISED: 0,
    TEST: 0,
    TEST_FLAG_INVALID: 0,
    ORPHAN_OWNER: 0,
    NOT_LIVE: 0,
    NO_PANEL: 1,
    LIVE_CANDIDATE: 0,
  },
  runs: [
    {
      id: '019600ab-cdef-7012-8345-6789abcd0099',
      state: 'COMPLETED',
      failureCode: null,
      readSetFingerprint: 'c'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      synthetic: true,
      sourceInvoiceRows: 1,
      insertedNew: 0,
      insertedRevision: 1,
      unchanged: 0,
      missingInSnapshot: 0,
      startedAt: '2026-10-07T09:00:00.000Z',
      finishedAt: '2026-10-07T09:01:00.000Z',
    },
  ],
};

const detail = (pii: boolean) => ({
  row: pii ? row() : redacted(),
  raw: {
    id_invoice: 'ab000001',
    id_user: pii ? '100000001' : null,
    username: pii ? 'svc_archive' : null,
    note: pii ? 'my config' : null,
    refral: pii ? '100000002' : null,
    Status: 'active',
    code_panel: '',
    price_product: '150000',
    notifctions: '{"volume":false,"time":false}',
  },
  redactedColumns: pii ? [] : ['id_user', 'note', 'refral', 'username'],
  revisions: [
    {
      id: '019600ab-cdef-7012-8345-6789abcd0002',
      revision: 1,
      revisionReason: 'FIRST_SEEN',
      classification: 'NOT_LIVE',
      rowChecksum: 'd'.repeat(64),
      sourceFingerprint: 'b'.repeat(64),
      readSetFingerprint: 'e'.repeat(64),
      runId: '019600ab-cdef-7012-8345-6789abcd0098',
      archivedAt: '2026-10-06T09:00:00.000Z',
      visible: true,
    },
    {
      id: ID,
      revision: 2,
      revisionReason: 'ROW_CHANGED',
      classification: 'NO_PANEL',
      rowChecksum: HASH,
      sourceFingerprint: 'b'.repeat(64),
      readSetFingerprint: 'c'.repeat(64),
      runId: '019600ab-cdef-7012-8345-6789abcd0099',
      archivedAt: '2026-10-07T09:00:00.000Z',
      visible: true,
    },
  ],
  importOutcome: {
    status: 'MANUAL_REVIEW',
    reasonCode: 'PROVIDER_MISSING',
    reviewState: 'OPEN',
    entityType: null,
  },
});

const calls = (api: ReturnType<typeof stubApi>, method: string, fragment: string) =>
  api.calls.filter((call) => call.method === method && call.url.includes(fragment));

function page(options: { pii?: boolean } = {}) {
  const pii = options.pii ?? true;
  const api = stubApi([
    {
      url: '/legacy-invoices',
      method: 'GET',
      body: { rows: [pii ? row() : redacted()], nextCursor: 'kYWIwMDAwMDE' },
    },
    { url: '/legacy-invoices/summary', method: 'GET', body: summary },
    { url: `/legacy-invoices/rows/${ID}`, method: 'GET', body: detail(pii) },
  ]);
  renderPage(<LegacyInvoicesPage denied={false} mayViewPii={pii} />);
  return api;
}

describe('the legacy invoice archive page', () => {
  it('lists archived invoices read-only, the price labelled as history', async () => {
    const api = page();
    expect(await screen.findByText('svc_archive')).toBeInTheDocument();
    expect(screen.getByText(t('web.lia_banner'))).toBeInTheDocument();
    expect(screen.getAllByText(t('web.lia_col_price')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(t('web.lia_class_no_panel')).length).toBeGreaterThan(0);
    // The summary carries counts only.
    expect(await screen.findByText(t('web.lia_summary_title'))).toBeInTheDocument();
    // Nothing on the page writes.
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
    for (const write of ['ثبت', 'حذف', 'تأیید', 'ویرایش']) {
      expect(screen.queryByRole('button', { name: write })).toBeNull();
    }
  });

  it('sends every filter, and pages with the opaque cursor', async () => {
    const api = page();
    await screen.findByText('svc_archive');
    const type = (label: Parameters<typeof t>[0], value: string) =>
      fireEvent.change(screen.getByLabelText(t(label)), { target: { value } });
    type('web.lia_filter_invoice', 'ab00');
    type('web.lia_filter_owner', '100000001');
    type('web.lia_filter_username', 'svc');
    type('web.lia_filter_status', 'end_of_time');
    type('web.lia_filter_panel', 'rp1');
    type('web.lia_filter_product', 'p1');
    fireEvent.change(screen.getByLabelText(t('web.lia_col_class')), {
      target: { value: 'ORPHAN_OWNER' },
    });
    fireEvent.change(screen.getByLabelText(t('web.lia_filter_test')), {
      target: { value: 'true' },
    });
    await waitFor(() =>
      expect(
        calls(
          api,
          'GET',
          'invoiceId=ab00&legacyUserId=100000001&username=svc&status=end_of_time&panelCode=rp1&productCode=p1&classification=ORPHAN_OWNER&test=true',
        ),
      ).toHaveLength(1),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.older') }));
    await waitFor(() => expect(calls(api, 'GET', 'after=kYWIwMDAwMDE')).toHaveLength(1));
  });

  it('without the PII key: personal cells hidden, PII search disabled and never sent', async () => {
    const api = page({ pii: false });
    expect(await screen.findByText(t('web.lia_pii_banner'))).toBeInTheDocument();
    expect(screen.queryByText('svc_archive')).toBeNull();
    expect((await screen.findAllByText(t('web.lia_hidden'))).length).toBeGreaterThan(0);
    expect(screen.getByLabelText(t('web.lia_filter_owner'))).toBeDisabled();
    expect(screen.getByLabelText(t('web.lia_filter_username'))).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lia_filter_status')), {
      target: { value: 'active' },
    });
    await waitFor(() => expect(calls(api, 'GET', 'status=active')).toHaveLength(1));
    expect(api.calls.some((call) => /legacyUserId|username=/u.test(call.url))).toBe(false);
  });

  it('never puts a PII filter in a query without the PII key, whatever the state holds', () => {
    const filters = { ...NO_FILTERS, legacyUserId: '100000001', username: 'svc', status: 'active' };
    expect(queryOf(filters, false, undefined)).toEqual({ status: 'active' });
    expect(queryOf(filters, true, 'kx')).toEqual({
      legacyUserId: '100000001',
      username: 'svc',
      status: 'active',
      after: 'kx',
    });
  });

  it('the detail shows raw cells, revisions, the importer outcome and provenance', async () => {
    page();
    await screen.findByText('svc_archive');
    fireEvent.click(screen.getByRole('button', { name: t('web.lia_open') }));
    expect(await screen.findByText('{"volume":false,"time":false}')).toBeInTheDocument();
    expect(screen.getByText(t('web.lia_history_only'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lia_no_panel_explained'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lia_revision_row_changed'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lia_revision_first'))).toBeInTheDocument();
    expect(screen.getByText('PROVIDER_MISSING')).toBeInTheDocument();
    expect(screen.getByText('my config')).toBeInTheDocument();
    expect(screen.getByText(HASH)).toBeInTheDocument();
  });

  it('the detail of a redacted reader shows the PII cells as hidden', async () => {
    page({ pii: false });
    await screen.findByText(t('web.lia_pii_banner'));
    fireEvent.click(await screen.findByRole('button', { name: t('web.lia_open') }));
    const raw = await screen.findByText(t('web.lia_raw_title'));
    const card = raw.closest('section') ?? document.body;
    expect(within(card as HTMLElement).getAllByText(t('web.lia_hidden')).length).toBe(4);
    expect(screen.queryByText('my config')).toBeNull();
    expect(screen.queryByText('100000002')).toBeNull();
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.invoices.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-invoices');
    expect(entry).toMatchObject({
      permission: 'legacy.invoices.view',
      group: 'web.navgroup_sales',
    });
    expect(navPermitted(entry!, ['legacy.invoices.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.products.view', 'orders.view'])).toBe(false);
    const route = { path: '/legacy-invoices', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.invoices.view']).title).toBe(t('web.lia_title'));
  });
});
