import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import {
  LegacyRecordsPage,
  ServiceLegacyHistoryCard,
} from '../../apps/web/src/pages/legacy-records';
import { t } from '../../apps/web/src/i18n/web.fa';
import { NAV, navPermitted, resolve } from '../../apps/web/src/app';
import { renderPage, stubApi } from './harness';

/**
 * «سوابق و تنظیمات میرزا» — the whole Mirza history archive and a service's Mirza records.
 * Fixtures go through the real API client and the contract's schemas.
 *
 * Defended here: the page is READ-ONLY (no write request is sent), every record type —
 * global ones and customer-less ones included — is listed with its counts, the type and
 * linked filters reach the query, paging uses the cursor, inactive Mirza panels are
 * summarised, a denied reader sends no request, and the route / nav entry are gated on
 * `legacy.history.view`.
 */

const ID1 = '019600ab-cdef-7012-8345-6789abcd0001';
const ID2 = '019600ab-cdef-7012-8345-6789abcd0002';
const SERVICE = '019600ab-cdef-7012-8345-6789abcd0077';

const item = (id: string, recordType: string, customerLinked: boolean) => ({
  id,
  recordType,
  occurredAt: null,
  packageImportId: 'pkg-1',
  summary: { codePanel: 'p999' },
  payload: { code_panel: 'p999', marker: `payload-of-${id.slice(-1)}` },
  redacted: [],
  legacyUserId: null,
  customerLinked,
});

const summary = {
  byType: [
    { recordType: 'service_operation', total: 79850, unlinked: 0 },
    { recordType: 'configuration_row', total: 141, unlinked: 141 },
    { recordType: 'panel_registry', total: 5, unlinked: 5 },
  ],
  total: 79996,
  unlinked: 146,
  inactivePanels: [{ code: 'p999', name: 'Panel X', panelType: 'MARZBAN', status: 'DISABLED' }],
};

const calls = (api: ReturnType<typeof stubApi>, fragment: string) =>
  api.calls.filter((call) => call.url.includes(fragment));

function page(denied = false) {
  const api = stubApi([
    { url: '/legacy-records/summary', method: 'GET', body: summary },
    {
      url: '/legacy-records',
      method: 'GET',
      body: { items: [item(ID1, 'configuration_row', false)], nextCursor: ID1, piiRedacted: true },
    },
  ]);
  renderPage(<LegacyRecordsPage denied={denied} />);
  return api;
}

describe('the Mirza records page', () => {
  it('lists every type with counts, the inactive panels, and writes nothing', async () => {
    const api = page();
    expect(await screen.findByText('Panel X')).toBeInTheDocument();
    expect(screen.getByText(t('web.lrec_status_disabled'))).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: new RegExp(t('web.c360_legacy_type_configuration_row')),
      }),
    ).toBeInTheDocument();
    expect(screen.getByText(t('web.lrec_pii_redacted'))).toBeInTheDocument();
    expect(screen.getAllByText(t('web.lrec_badge_unlinked')).length).toBeGreaterThan(0);
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('sends the type and linked filters, and pages with the cursor', async () => {
    const api = page();
    fireEvent.click(
      await screen.findByRole('button', {
        name: new RegExp(t('web.c360_legacy_type_panel_registry')),
      }),
    );
    await waitFor(() =>
      expect(
        calls(api, '/legacy-records?').some((c) => c.url.includes('type=panel_registry')),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('button', { name: t('web.lrec_linked_no') }));
    await waitFor(() =>
      expect(
        calls(api, '/legacy-records?').some(
          (c) => c.url.includes('type=panel_registry') && c.url.includes('linked=no'),
        ),
      ).toBe(true),
    );
    fireEvent.click(await screen.findByRole('button', { name: t('web.page_next') }));
    await waitFor(() =>
      expect(calls(api, '/legacy-records?').some((c) => c.url.includes(`after=${ID1}`))).toBe(true),
    );
    // Ten rows a page, as every other server-paged list.
    expect(calls(api, '/legacy-records?').every((c) => c.url.includes('limit=10'))).toBe(true);
  });

  it('a reader without the permission sends no request', () => {
    const api = page(true);
    expect(api.calls).toEqual([]);
  });
});

describe('the service page section', () => {
  it('shows the invoice key and the records of the adopted invoice', async () => {
    const api = stubApi([
      {
        url: `/services/${SERVICE}/legacy-history`,
        method: 'GET',
        body: {
          invoiceKeys: ['ab000001'],
          items: [item(ID2, 'service_operation', true)],
          truncated: false,
          piiRedacted: true,
        },
      },
    ]);
    renderPage(<ServiceLegacyHistoryCard serviceId={SERVICE} mayView />);
    expect(await screen.findByText('ab000001')).toBeInTheDocument();
    expect(screen.getByText(t('web.c360_legacy_details'))).toBeInTheDocument();
    expect(api.calls.filter((call) => call.method !== 'GET')).toEqual([]);
  });

  it('says so when the service was not adopted, and asks nothing without the permission', async () => {
    stubApi([
      {
        url: `/services/${SERVICE}/legacy-history`,
        method: 'GET',
        body: { invoiceKeys: [], items: [], truncated: false, piiRedacted: true },
      },
    ]);
    renderPage(<ServiceLegacyHistoryCard serviceId={SERVICE} mayView />);
    expect(await screen.findByText(t('web.lrec_service_empty'))).toBeInTheDocument();
  });

  it('is not drawn and sends no request when legacy.history.view is not held', () => {
    const api = stubApi([]);
    renderPage(<ServiceLegacyHistoryCard serviceId={SERVICE} mayView={false} />);
    expect(screen.queryByText(t('web.lrec_service_title'))).toBeNull();
    expect(api.calls).toEqual([]);
  });
});

describe('the route and the nav entry', () => {
  it('is gated on legacy.history.view', () => {
    const entry = NAV.find((candidate) => candidate.path === '/legacy-records');
    expect(entry).toMatchObject({ permission: 'legacy.history.view', group: 'web.navgroup_sales' });
    expect(navPermitted(entry!, ['legacy.history.view'])).toBe(true);
    expect(navPermitted(entry!, ['legacy.invoices.view'])).toBe(false);
    const route = { path: '/legacy-records', query: new URLSearchParams() };
    expect(resolve(route, ['legacy.history.view']).title).toBe(t('web.lrec_title'));
  });
});
