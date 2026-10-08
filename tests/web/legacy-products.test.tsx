import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { LegacyProductsPage } from '../../apps/web/src/pages/legacy-products';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * Mirza PR2 — the legacy product review page. Fixtures go through the real API client and
 * the contract's schemas.
 *
 * What this file defends: the historical price is labelled history; the default view is the
 * rows that want a decision; the raw facts are shown verbatim; approve-as-new sends the
 * checksum the operator saw and NO price, panel, category or status; reject needs a reason;
 * a reader without `legacy.products.decide` gets no decision; the page and its nav entry are
 * gated on `legacy.products.view` (MEDIUM: an observer does not see it).
 */

const ID = '019600ab-cdef-7012-8345-6789abcdef01';
const PRODUCT_ID = '019600ab-cdef-7012-8345-6789abcdef99';
const CHECKSUM = 'c'.repeat(64);

const review = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  codeProduct: 'p1',
  legacyProductId: '1',
  state: 'PENDING_REVIEW',
  facts: [
    {
      id: '1',
      code_product: 'p1',
      name_product: 'synthetic 30GB',
      price_product: '150000',
      Volume_constraint: '30',
      Service_time: '30',
      hide_panel: '{"rp1":"rp1"}',
    },
  ],
  factsChecksum: CHECKSUM,
  sourceConflict: null,
  title: 'synthetic 30GB',
  trafficBytes: String(30n * 1024n ** 3n),
  durationDays: 30,
  historicalPriceRaw: '150000',
  historicalPriceMinor: '150000',
  historicalPriceCurrency: 'IRT',
  parseNotes: {},
  liveInvoiceCount: 3,
  approvedProductId: null,
  approvedProductTitle: null,
  approvedFactsChecksum: null,
  priorState: null,
  decisionReason: null,
  decidedByAdminId: null,
  decidedAt: null,
  readFingerprint: 'a'.repeat(64),
  sourceFingerprint: 'b'.repeat(64),
  missingSinceReadFingerprint: null,
  exportable: false,
  version: 1,
  createdAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  ...overrides,
});

const calls = (api: ReturnType<typeof stubApi>, method: string, fragment: string) =>
  api.calls.filter((call) => call.method === method && call.url.includes(fragment));

function page(options: { mayDecide?: boolean; mayCreateProduct?: boolean; rows?: unknown[] } = {}) {
  const api = stubApi([
    {
      url: '/legacy-products',
      method: 'GET',
      body: { reviews: options.rows ?? [review()], nextCursor: null },
    },
    {
      url: `/legacy-products/${ID}/approve-new`,
      method: 'POST',
      body: { review: review({ state: 'APPROVED_NEW', approvedProductId: PRODUCT_ID }) },
    },
    {
      url: `/legacy-products/${ID}/reject`,
      method: 'POST',
      body: { review: review({ state: 'REJECTED' }) },
    },
    {
      url: `/legacy-products/${ID}/reopen`,
      method: 'POST',
      body: { review: review() },
    },
    { url: '/products', method: 'GET', body: { products: [], nextCursor: null } },
  ]);
  renderPage(
    <LegacyProductsPage
      denied={false}
      mayDecide={options.mayDecide ?? true}
      mayCreateProduct={options.mayCreateProduct ?? true}
      mayPickProduct
    />,
  );
  return api;
}

describe('the legacy product review page', () => {
  it('lists the rows that want a decision, with the price labelled as history', async () => {
    const api = page();
    expect(await screen.findByText('synthetic 30GB')).toBeInTheDocument();
    expect(screen.getByText(t('web.lpr_banner'))).toBeInTheDocument();
    expect(screen.getAllByText(t('web.lpr_col_historical_price')).length).toBeGreaterThan(0);
    expect(calls(api, 'GET', '/legacy-products?attention=true')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText(t('web.lpr_col_state')), {
      target: { value: 'REJECTED' },
    });
    await waitFor(() => expect(calls(api, 'GET', 'state=REJECTED')).toHaveLength(1));
  });

  it('shows the raw facts verbatim and sends approve-as-new with the checksum and no price', async () => {
    const api = page();
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    expect(await screen.findByText('{"rp1":"rp1"}')).toBeInTheDocument();
    expect(screen.getByText(t('web.lpr_draft_explained'))).toBeInTheDocument();
    expect(screen.getByLabelText(t('web.lpr_draft_traffic'))).toHaveValue('30');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_approve_new') }));
    await waitFor(() => expect(calls(api, 'POST', '/approve-new')).toHaveLength(1));
    const body = calls(api, 'POST', '/approve-new')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      expectedFactsChecksum: CHECKSUM,
      title: 'synthetic 30GB',
      durationDays: 30,
      trafficBytes: String(30n * 1024n ** 3n),
    });
    for (const forbidden of ['price', 'panelId', 'categoryId', 'audience', 'status']) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it('reject needs a reason; a decided row offers reopen', async () => {
    const api = page({
      rows: [
        review(),
        review({ id: `${ID.slice(0, -2)}02`, codeProduct: 'p2', state: 'REJECTED', title: 'دو' }),
      ],
    });
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getAllByRole('button', { name: t('web.lpr_open') })[0]!);
    const reject = await screen.findByRole('button', { name: t('web.lpr_reject') });
    expect(reject).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lpr_reason')), { target: { value: 'نه' } });
    fireEvent.click(reject);
    await waitFor(() => expect(calls(api, 'POST', '/reject')).toHaveLength(1));
    expect(calls(api, 'POST', '/reject')[0]!.body).toMatchObject({
      expectedFactsChecksum: CHECKSUM,
      expectedVersion: 1,
      reason: 'نه',
    });
  });

  it('a reopen names the version shown; a stale one is refused in words (Codex #231)', async () => {
    const decided = review({
      state: 'APPROVED_EXISTING',
      approvedProductId: PRODUCT_ID,
      version: 4,
    });
    const api = stubApi([
      { url: '/legacy-products', method: 'GET', body: { reviews: [decided], nextCursor: null } },
      {
        url: `/legacy-products/${ID}/reopen`,
        method: 'POST',
        status: 409,
        body: {
          error: {
            kind: 'conflict',
            code: 'legacy_product_review.version_conflict',
            message: 'stale',
            correlationId: 'test',
          },
        },
      },
    ]);
    renderPage(<LegacyProductsPage denied={false} mayDecide mayCreateProduct mayPickProduct />);
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    fireEvent.change(await screen.findByLabelText(t('web.lpr_reason')), {
      target: { value: 'دوباره' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_reopen') }));
    await waitFor(() => expect(calls(api, 'POST', '/reopen')).toHaveLength(1));
    expect(calls(api, 'POST', '/reopen')[0]!.body).toMatchObject({
      expectedVersion: 4,
      reason: 'دوباره',
    });
    expect(await screen.findByText(t('web.lpr_fault_version'))).toBeInTheDocument();
  });

  it('without decide, the detail is read-only; without catalog.edit, no draft form', async () => {
    page({ mayDecide: false });
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    expect(await screen.findByText(t('web.lpr_view_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lpr_reject') })).toBeNull();
  });

  it('approve-as-new is not offered without catalog.edit', async () => {
    page({ mayCreateProduct: false });
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    expect(await screen.findByText(t('web.lpr_no_catalog_edit'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.lpr_draft_title'))).toBeNull();
  });

  it('a duplicated or vanished code cannot be approved, only rejected', async () => {
    page({
      rows: [
        review({ sourceConflict: 'CODE_DUPLICATED', parseNotes: { title: 'SOURCE_CONFLICT' } }),
      ],
    });
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    const drawer = await screen.findByText(t('web.lpr_conflict_explained'));
    expect(drawer).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lpr_approve_new') })).toBeNull();
    expect(screen.getByRole('button', { name: t('web.lpr_reject') })).toBeInTheDocument();
    expect(
      within(document.body).getByText(t('web.lpr_note_conflict'), { exact: false }),
    ).toBeInTheDocument();
  });
});

describe('the approve-existing product picker', () => {
  const product = (n: number) => ({
    id: `019600ab-cdef-7012-8345-${String(n).padStart(12, '0')}`,
    title: `plan ${String(n)}`,
    description: null,
    status: 'ACTIVE',
    audience: 'EVERYONE',
    sortOrder: n,
    panelId: null,
    categoryId: null,
    durationDays: 30,
    trafficBytes: '1',
    deviceLimit: null,
    priceAmount: null,
    priceCurrency: null,
    displayLocations: [],
    displayFeatures: [],
    serviceLocationLabel: null,
    createdAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:00.000Z',
  });

  it('offers every product, past the first page of 100 (Codex #231)', async () => {
    const first = Array.from({ length: 100 }, (_, i) => product(i + 1));
    const second = Array.from({ length: 5 }, (_, i) => product(101 + i));
    const api = stubApi([
      { url: '/legacy-products', method: 'GET', body: { reviews: [review()], nextCursor: null } },
      { url: '/products?limit=100', method: 'GET', body: { products: first, nextCursor: 'c1' } },
      {
        url: '/products?limit=100&cursor=c1',
        method: 'GET',
        body: { products: second, nextCursor: null },
      },
    ]);
    renderPage(<LegacyProductsPage denied={false} mayDecide mayCreateProduct mayPickProduct />);
    await screen.findByText('synthetic 30GB');
    fireEvent.click(screen.getByRole('button', { name: t('web.lpr_open') }));
    const picker = await screen.findByLabelText(t('web.lpr_pick_product'));
    await waitFor(() =>
      expect(within(picker).getByRole('option', { name: 'plan 105' })).toBeInTheDocument(),
    );
    // "—" plus all 105.
    expect(within(picker).getAllByRole('option')).toHaveLength(106);
    expect(calls(api, 'GET', 'cursor=c1')).toHaveLength(1);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.products.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-products');
    expect(entry).toMatchObject({
      permission: 'legacy.products.view',
      group: 'web.navgroup_sales',
    });
    expect(navPermitted(entry!, ['legacy.products.view'])).toBe(true);
    expect(navPermitted(entry!, ['catalog.view', 'catalog.edit'])).toBe(false);
    const route = { path: '/legacy-products', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.products.view']).title).toBe(t('web.lpr_title'));
  });
});
