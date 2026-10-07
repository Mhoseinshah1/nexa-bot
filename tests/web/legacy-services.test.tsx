import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { LEGACY_SERVICE_OUTCOMES, LEGACY_SERVICE_REVIEW_STATES } from '@nexa/contracts';
import { LegacyServicesPage } from '../../apps/web/src/pages/legacy-services';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { panel as panelFixture, renderPage, stubApi } from './harness';

/**
 * Mirza PR5 — the legacy service candidates page (owner decision 8). Fixtures go through the
 * real API client and the contract's schemas.
 *
 * What this file defends: the list filters by outcome, review state, panel and product, and
 * sends the invoice id VERBATIM (never trimmed); the detail says why the candidate did not
 * adopt and shows the evidence; an ADOPT on a no-panel invoice sends the strict body with a
 * panel chosen from the mapped holders, bound to the version shown; the panel picker walks
 * every page of panels; with no mapped holder the ADOPT cannot be sent; without
 * `legacy.services.decide` nothing writes; the route and nav entry are gated on
 * `legacy.services.view` (MEDIUM).
 */

const ID = '019600ab-cdef-7012-8345-6789abcd0201';
const PANEL_B = '019600ab-cdef-7012-8345-6789abcd0b0b';
const PANEL_A = '019600ab-cdef-7012-8345-6789abcd0a0a';

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  invoiceKey: '1700001b2c3d4e5',
  outcome: 'NO_PANEL',
  blocker: 'PANEL_UNMAPPED',
  reviewState: 'OPEN',
  panelCode: null,
  productCode: null,
  evidence: {
    panelCodeClass: 'EMPTY',
    mappedPanelId: null,
    customer: 'IMPORTED',
    holders: [{ panelId: PANEL_B, mapped: true, spellings: 1, state: 'active' }],
    incompletePanels: [],
    product: { path: 'HIDDEN_SHAPE', productId: null, resolved: true },
    claims: 1,
  },
  archiveId: null,
  serviceId: null,
  approvedPanelId: null,
  lastApprovalRefusal: null,
  decisionReason: null,
  decidedByAdminId: null,
  decidedAt: null,
  runId: '019600ab-cdef-7012-8345-6789abcd0299',
  sourceFingerprint: 'b'.repeat(64),
  invoiceChecksum: 'c'.repeat(64),
  synthetic: false,
  observedAt: '2026-10-07T09:00:00.000Z',
  version: 3,
  firstDecidedAt: '2026-10-07T09:00:00.000Z',
  updatedAt: '2026-10-07T09:00:00.000Z',
  ...overrides,
});

const summary = {
  candidateCount: 1,
  byOutcome: Object.fromEntries(LEGACY_SERVICE_OUTCOMES.map((o) => [o, o === 'NO_PANEL' ? 1 : 0])),
  byReviewState: Object.fromEntries(
    LEGACY_SERVICE_REVIEW_STATES.map((s) => [s, s === 'OPEN' ? 1 : 0]),
  ),
};

const panel = (id: string, name: string) => panelFixture({ id, name });

function page(
  options: {
    mayDecide?: boolean;
    row?: Record<string, unknown>;
    adoptPanels?: string[];
  } = {},
) {
  const row = candidate(options.row);
  const api = stubApi([
    { url: '/legacy-services', method: 'GET', body: { candidates: [row], nextCursor: null } },
    { url: '/legacy-services/summary', method: 'GET', body: summary },
    {
      url: `/legacy-services/${ID}`,
      method: 'GET',
      body: {
        candidate: row,
        archive: null,
        importOutcome: {
          status: 'MANUAL_REVIEW',
          reasonCode: 'PANEL_UNMAPPED',
          reviewState: 'OPEN',
        },
        adoptPanels: options.adoptPanels ?? [PANEL_B],
      },
    },
    // Two pages of panels: the picker's names must come from the second page too.
    {
      url: '/panels?limit=100&cursor=p2',
      method: 'GET',
      body: { panels: [panel(PANEL_B, 'Panel B (page 2)')], nextCursor: null },
    },
    {
      url: '/panels?limit=100',
      method: 'GET',
      body: { panels: [panel(PANEL_A, 'Panel A')], nextCursor: 'p2' },
    },
    {
      url: `/legacy-services/${ID}/adopt`,
      method: 'POST',
      body: {
        candidate: candidate({
          reviewState: 'ADOPT_APPROVED',
          approvedPanelId: PANEL_B,
          approvedChecksum: 'c'.repeat(64),
          version: 4,
        }),
      },
    },
    {
      url: `/legacy-services/${ID}/decide`,
      method: 'POST',
      body: { candidate: candidate({ reviewState: 'KEPT_AS_HISTORY', version: 4 }) },
    },
  ]);
  renderPage(
    <LegacyServicesPage
      denied={false}
      mayDecide={options.mayDecide ?? true}
      mayViewPanels
      mayViewArchive
    />,
  );
  return api;
}

describe('the legacy service candidates page', () => {
  it('lists the open candidates with their outcome; filters reach the server, the invoice id verbatim', async () => {
    const api = page();
    expect(await screen.findByText('1700001b2c3d4e5')).toBeInTheDocument();
    expect(screen.getByText(t('web.lsr_banner'))).toBeInTheDocument();
    await waitFor(() =>
      expect(api.calls.some((c) => c.method === 'GET' && c.url.includes('reviewState=OPEN'))).toBe(
        true,
      ),
    );
    fireEvent.change(screen.getByLabelText(t('web.lsr_col_outcome')), {
      target: { value: 'NO_PANEL' },
    });
    fireEvent.change(screen.getByLabelText(t('web.lsr_col_panel_code')), {
      target: { value: 'rp2' },
    });
    fireEvent.change(screen.getByLabelText(t('web.lsr_col_product_code')), {
      target: { value: 'p1' },
    });
    fireEvent.change(screen.getByLabelText(t('web.lsr_search_invoice')), {
      target: { value: ' a0 ' },
    });
    await waitFor(() =>
      expect(
        api.calls.some(
          (c) =>
            c.url.includes('outcome=NO_PANEL') &&
            c.url.includes('panelCode=rp2') &&
            c.url.includes('productCode=p1') &&
            c.url.includes('invoiceId=+a0+'),
        ),
      ).toBe(true),
    );
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('the detail says why it did not adopt; an ADOPT names a mapped holder (from any panel page) and binds the version', async () => {
    const api = page();
    fireEvent.click(await screen.findByRole('button', { name: t('web.lsr_open') }));
    expect(await screen.findByText(t('web.lsr_why_no_panel'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lsr_adopt_explained'))).toBeInTheDocument();
    // The holder's name came from the SECOND page of panels.
    expect((await screen.findAllByText(/Panel B \(page 2\)/u)).length).toBeGreaterThan(0);
    const adopt = screen.getByRole('button', { name: t('web.lsr_adopt') });
    expect(adopt).toBeDisabled();
    fireEvent.change(screen.getByLabelText(t('web.lsr_reason')), {
      target: { value: 'حساب در پنل B' },
    });
    fireEvent.click(screen.getByRole('button', { name: t('web.lsr_adopt') }));
    await waitFor(() =>
      expect(api.calls.filter((c) => c.method === 'POST' && c.url.includes('/adopt'))).toHaveLength(
        1,
      ),
    );
    const sent = api.calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual([
      'expectedVersion',
      'idempotencyKey',
      'panelId',
      'reason',
    ]);
    expect(sent).toMatchObject({ expectedVersion: 3, panelId: PANEL_B, reason: 'حساب در پنل B' });
  });

  it('with no mapped holder the ADOPT cannot be sent, and the page says why', async () => {
    const api = page({ adoptPanels: [] });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lsr_open') }));
    expect(await screen.findByText(t('web.lsr_adopt_no_panel_available'))).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(t('web.lsr_reason')), { target: { value: 'x' } });
    expect(screen.getByRole('button', { name: t('web.lsr_adopt') })).toBeDisabled();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('a mapped invoice sends no panel: the map’s panel is never overridden by a click', async () => {
    const api = page({
      row: {
        outcome: 'PRODUCT_UNRESOLVED',
        blocker: 'PRODUCT_MAPPING_UNRESOLVED',
        panelCode: 'rp1',
        evidence: {
          panelCodeClass: 'MAPPED',
          mappedPanelId: PANEL_A,
          customer: 'IMPORTED',
          holders: [{ panelId: PANEL_A, mapped: true, spellings: 1, state: 'active' }],
          incompletePanels: [],
          product: { path: 'NAMED_PRODUCT', productId: null, resolved: false },
          claims: 1,
        },
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lsr_open') }));
    expect(await screen.findByText(t('web.lsr_why_product_unresolved'))).toBeInTheDocument();
    expect(screen.queryByLabelText(t('web.lsr_adopt_panel'))).toBeNull();
    fireEvent.change(screen.getByLabelText(t('web.lsr_reason')), { target: { value: 'نگاشت شد' } });
    fireEvent.click(screen.getByRole('button', { name: t('web.lsr_adopt') }));
    await waitFor(() => expect(api.calls.some((c) => c.method === 'POST')).toBe(true));
    const sent = api.calls.find((c) => c.method === 'POST')?.body as Record<string, unknown>;
    expect(sent).not.toHaveProperty('panelId');
  });

  it('an outcome no decision can fix offers no ADOPT; an adopted candidate offers nothing', async () => {
    page({ row: { outcome: 'TEST_INVOICE_SKIPPED', blocker: 'HISTORY_NOT_IMPORTED' } });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lsr_open') }));
    expect(await screen.findByRole('button', { name: t('web.lsr_keep') })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lsr_adopt') })).toBeNull();
  });

  it('without legacy.services.decide nothing on the page writes', async () => {
    const api = page({ mayDecide: false });
    fireEvent.click(await screen.findByRole('button', { name: t('web.lsr_open') }));
    expect(await screen.findByText(t('web.lsr_view_only'))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: t('web.lsr_adopt') })).toBeNull();
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.services.view, which an observer (LOW keys) does not hold', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-services');
    expect(entry).toMatchObject({
      permission: 'legacy.services.view',
      group: 'web.navgroup_sales',
    });
    expect(navPermitted(entry!, ['legacy.services.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.invoices.view', 'orders.view'])).toBe(false);
    const route = { path: '/legacy-services', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.services.view']).title).toBe(t('web.lsr_title'));
  });
});
