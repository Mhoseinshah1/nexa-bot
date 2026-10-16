import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { LEDGER_REASONS } from '@nexa/contracts';
import {
  CustomerLegacyDebtCard,
  CustomerLegacyInvoicesCard,
} from '../../apps/web/src/pages/customer-360-legacy';
import { LegacyDebtsPage, legacyDebtFiltersOf } from '../../apps/web/src/pages/legacy-debts';
import {
  LegacyInvoicesPage,
  legacyInvoiceFiltersOf,
} from '../../apps/web/src/pages/legacy-invoices';
import {
  LegacyServicesPage,
  LEGACY_SERVICE_OUTCOME_LABELS,
  legacyServiceFiltersOf,
} from '../../apps/web/src/pages/legacy-services';
import {
  LEDGER_REASON_LABELS,
  MIRZA_INVOICE_STATUS_LABELS,
  migrationCodeView,
  migrationSectionView,
  mirzaStatusLabel,
} from '../../apps/web/src/pages/mirza-labels';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';
import { renderPage, stubApi } from './harness';

/**
 * Customer 360 after a Mirza import: the customer's legacy invoices beside what the import
 * made of each (adopted, held for review, history — never an order), Mirza's verbatim status
 * labelled only where its writer is documented, the legacy debt beside the wallet (never
 * collected), every ledger reason named, and the migration report's links presetting the
 * global legacy pages. SYNTHETIC values only.
 */

const ID = '019210ab-cdef-7012-8345-6789abcdef01';
const SERVICE = '019210ab-cdef-7012-8345-6789abcdef77';
const TG = '7000000101';

const invoice = (over: Record<string, unknown> = {}) => ({
  archiveId: '019210ab-cdef-7012-8345-6789abcdef10',
  invoiceKey: 'inv-a1',
  revision: 1,
  classification: 'LIVE_CANDIDATE',
  live: true,
  status: 'active',
  isTest: false,
  username: null,
  panelCode: 'rp1',
  productCode: null,
  productName: 'synthetic 30d',
  priceMinor: '150000',
  priceCurrency: 'IRT',
  soldAt: '2023-11-14T22:13:20.000Z',
  candidate: null,
  ...over,
});

const candidate = (over: Record<string, unknown> = {}) => ({
  id: '019210ab-cdef-7012-8345-6789abcdef20',
  outcome: 'ADOPTED',
  blocker: null,
  reviewState: 'ADOPTED',
  serviceId: SERVICE,
  ...over,
});

const invoicesPage = (over: Record<string, unknown> = {}) => ({
  invoices: [
    invoice({ candidate: candidate() }),
    invoice({
      archiveId: '019210ab-cdef-7012-8345-6789abcdef11',
      invoiceKey: 'inv-a2',
      status: 'disablebyadmin',
      candidate: candidate({
        id: '019210ab-cdef-7012-8345-6789abcdef21',
        outcome: 'INVENTORY_INCOMPLETE',
        blocker: 'TOTAL_CHANGED',
        reviewState: 'OPEN',
        serviceId: null,
      }),
    }),
    invoice({
      archiveId: '019210ab-cdef-7012-8345-6789abcdef12',
      invoiceKey: 'inv-a3',
      classification: 'NOT_LIVE',
      live: false,
      status: 'removebyuser',
    }),
    invoice({
      archiveId: '019210ab-cdef-7012-8345-6789abcdef13',
      invoiceKey: 'inv-a4',
      classification: 'NOT_LIVE',
      live: false,
      status: 'weird_status',
    }),
  ],
  nextCursor: 'kaW52LWE0',
  piiRedacted: true,
  candidatesVisible: true,
  ...over,
});

const row = (key: string) => {
  const cell = screen.getByText(key);
  const tr = cell.closest('tr');
  if (tr === null) throw new Error(`no row for ${key}`);
  return within(tr);
};

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => navigate('/', { replace: true, force: true }));
});

describe('the customer’s Mirza invoices', () => {
  it('is not drawn, and asks for nothing, without legacy.invoices.view', () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-invoices`, body: invoicesPage() }]);
    const { container } = renderPage(
      <CustomerLegacyInvoicesCard
        customerId={ID}
        telegramUserId={TG}
        mayView={false}
        mayViewPii={false}
      />,
    );
    expect(container.textContent).toBe('');
    expect(api.calls).toHaveLength(0);
  });

  it('says what the import made of each invoice: adopted, held with its reason, history', async () => {
    const api = stubApi([{ url: `/users/${ID}/legacy-invoices`, body: invoicesPage() }]);
    renderPage(
      <CustomerLegacyInvoicesCard customerId={ID} telegramUserId={TG} mayView mayViewPii={false} />,
    );
    await screen.findByText('inv-a1');
    // History, never an order — said on the card.
    expect(screen.getByText(t('web.c360_li_hint'))).toBeInTheDocument();
    expect(screen.getByText(t('web.c360_li_pii_redacted'))).toBeInTheDocument();

    const adopted = row('inv-a1');
    expect(adopted.getByText(t('web.c360_li_adopted'))).toBeInTheDocument();
    expect(adopted.getByRole('link', { name: t('web.c360_li_open_service') })).toHaveAttribute(
      'href',
      `/services/${SERVICE}`,
    );
    expect(adopted.getByText(t('web.mrz_status_active'))).toBeInTheDocument();

    const held = row('inv-a2');
    expect(held.getByText(t('web.c360_li_needs_review'))).toBeInTheDocument();
    expect(
      held.getByText(new RegExp(t('web.lsr_outcome_inventory_incomplete'))),
    ).toBeInTheDocument();
    expect(held.getByText('TOTAL_CHANGED')).toBeInTheDocument();
    expect(held.getByText(t('web.mrz_status_disablebyadmin'))).toBeInTheDocument();
    expect(held.getByRole('link', { name: t('web.c360_li_open_review') })).toHaveAttribute(
      'href',
      '/legacy-services?reviewState=ALL&invoiceId=inv-a2',
    );
    expect(held.queryByRole('link', { name: t('web.c360_li_open_service') })).toBeNull();

    const removed = row('inv-a3');
    expect(removed.getByText(t('web.c360_li_history_only'))).toBeInTheDocument();
    expect(removed.getByText(t('web.mrz_status_removebyuser'))).toBeInTheDocument();

    // An undocumented status is unknown, with its raw value — never guessed.
    const unknown = row('inv-a4');
    expect(unknown.getByText(t('web.mrz_status_unknown'))).toBeInTheDocument();
    expect(unknown.getByText('weird_status')).toBeInTheDocument();

    // Without the PII key the archive link carries no Telegram id.
    expect(screen.getByRole('link', { name: t('web.c360_li_all') })).toHaveAttribute(
      'href',
      '/legacy-invoices',
    );
    fireEvent.click(screen.getByRole('button', { name: /بعدی/ }));
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('after=kaW52LWE0'))).toBe(true),
    );
  });

  it('without legacy.services.view says the outcomes need a permission, and claims none', async () => {
    stubApi([
      {
        url: `/users/${ID}/legacy-invoices`,
        body: invoicesPage({
          candidatesVisible: false,
          piiRedacted: false,
          nextCursor: null,
          invoices: [invoice({ username: 'syn_user' })],
        }),
      },
    ]);
    renderPage(
      <CustomerLegacyInvoicesCard customerId={ID} telegramUserId={TG} mayView mayViewPii />,
    );
    await screen.findByText('inv-a1');
    expect(screen.getByText(t('web.c360_li_outcomes_hidden'))).toBeInTheDocument();
    expect(screen.getByText(t('web.c360_li_hidden'))).toBeInTheDocument();
    expect(screen.queryByText(t('web.c360_li_adopted'))).toBeNull();
    expect(screen.getByText('syn_user')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: t('web.c360_li_all') })).toHaveAttribute(
      'href',
      `/legacy-invoices?legacyUserId=${TG}`,
    );
  });
});

describe('Mirza’s verbatim status', () => {
  it('labels only the documented values, exactly and case-sensitively', () => {
    for (const value of [
      'active',
      'disabled',
      'disabledn',
      'disablebyadmin',
      'end_of_volume',
      'end_of_time',
      'sendedwarn',
      'send_on_hold',
      'removebyuser',
      'removebyadmin',
      'removedbyadmin',
      'removeTime',
      'removevolume',
      'unpaid',
      'Unsuccessful',
    ]) {
      expect(mirzaStatusLabel(value), value).toBe(t(MIRZA_INVOICE_STATUS_LABELS[value] as never));
    }
    for (const value of ['Active', 'removed', 'expired', 'unsuccessful', '', 'toString', null]) {
      expect(mirzaStatusLabel(value), String(value)).toBeNull();
    }
  });
});

describe('the customer’s legacy debt', () => {
  const debt = {
    id: '019210ab-cdef-7012-8345-6789abcdef30',
    customerId: ID,
    legacyUserId: TG,
    amountMinor: '45000',
    currency: 'IRT',
    state: 'PENDING_REVIEW',
    sourceFingerprint: 'a'.repeat(64),
    rowChecksum: 'b'.repeat(64),
    runId: '019210ab-cdef-7012-8345-6789abcdef31',
    synthetic: true,
    decisionReason: null,
    decidedByAdminId: null,
    decidedAt: null,
    version: 1,
    recordedAt: '2026-10-07T09:00:00.000Z',
    updatedAt: '2026-10-07T09:00:00.000Z',
  };

  it('is shown beside the wallet as review-only, never collected', async () => {
    const api = stubApi([{ url: '/legacy-debts', body: { debts: [debt], nextCursor: null } }]);
    renderPage(<CustomerLegacyDebtCard telegramUserId={TG} mayView />);
    expect(await screen.findByText(t('web.c360_debt_title'))).toBeInTheDocument();
    expect(await screen.findByText(t('web.lwd_state_pending'))).toBeInTheDocument();
    expect(screen.getByText(t('web.lwd_never_collected'))).toBeInTheDocument();
    expect(screen.getByText(t('web.c360_debt_synthetic'))).toBeInTheDocument();
    expect(api.calls[0]?.url).toContain(`legacyUserId=${TG}`);
    expect(screen.getByRole('link', { name: t('web.c360_debt_open') })).toHaveAttribute(
      'href',
      `/legacy-debts?state=ALL&legacyUserId=${TG}`,
    );
  });

  it('draws nothing when there is no debt, and asks nothing without legacy.debts.view', async () => {
    const api = stubApi([{ url: '/legacy-debts', body: { debts: [], nextCursor: null } }]);
    const denied = renderPage(<CustomerLegacyDebtCard telegramUserId={TG} mayView={false} />);
    expect(denied.container.textContent).toBe('');
    expect(api.calls).toHaveLength(0);
    denied.unmount();
    const none = renderPage(<CustomerLegacyDebtCard telegramUserId={TG} mayView />);
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await waitFor(() => expect(none.container.textContent).toBe(''));
  });
});

describe('the ledger reasons', () => {
  it('names every reason, and the migration opening balance as Mirza’s', () => {
    for (const reason of LEDGER_REASONS) {
      expect(t(LEDGER_REASON_LABELS[reason]), reason).toMatch(/[؀-ۿ]/u);
    }
    expect(new Set(LEDGER_REASONS.map((r) => LEDGER_REASON_LABELS[r])).size).toBe(
      LEDGER_REASONS.length,
    );
    expect(t(LEDGER_REASON_LABELS.MIGRATION_OPENING_BALANCE)).toContain('میرزا');
  });
});

describe('the migration report names', () => {
  it('labels sections and codes and links them to the filtered lists; an unknown one stays raw', () => {
    expect(migrationSectionView('services')).toEqual({
      label: t('web.mrz_section_services'),
      href: '/legacy-services?reviewState=ALL',
    });
    expect(migrationSectionView('history:ticket').label).toContain(
      t('web.c360_legacy_type_ticket'),
    );
    expect(migrationSectionView('history:nope').label).toBeNull();
    expect(migrationSectionView('table:SUPPORTED:user').label).toBe(t('web.mrz_section_table'));
    expect(migrationSectionView('something_else')).toEqual({ label: null, href: null });
    expect(migrationCodeView('AMBIGUOUS_OWNERSHIP', LEGACY_SERVICE_OUTCOME_LABELS)).toEqual({
      label: t('web.lsr_outcome_ambiguous_ownership'),
      href: '/legacy-services?outcome=AMBIGUOUS_OWNERSHIP&reviewState=ALL',
    });
    expect(migrationCodeView('PRODUCT_NO_TARIFF', LEGACY_SERVICE_OUTCOME_LABELS).href).toBe(
      '/legacy-products',
    );
    expect(
      migrationCodeView('PROVIDER_INVENTORY_INCOMPLETE:TIMEOUT', LEGACY_SERVICE_OUTCOME_LABELS)
        .label,
    ).toBe(t('web.mrz_code_provider_inventory_incomplete'));
    expect(migrationCodeView('NEVER_SEEN', LEGACY_SERVICE_OUTCOME_LABELS)).toEqual({
      label: null,
      href: null,
    });
  });
});

describe('the global legacy pages read their filters from the link', () => {
  it('parses each page’s query, ignoring a value outside its closed set', () => {
    expect(
      legacyServiceFiltersOf(new URLSearchParams('outcome=NO_PANEL&reviewState=ALL&invoiceId=k1')),
    ).toMatchObject({ outcome: 'NO_PANEL', reviewState: 'ALL', invoiceId: 'k1' });
    expect(
      legacyServiceFiltersOf(new URLSearchParams('outcome=BOGUS&reviewState=BOGUS')),
    ).toMatchObject({ outcome: 'ALL', reviewState: 'OPEN' });
    expect(
      legacyInvoiceFiltersOf(
        new URLSearchParams('legacyUserId=7000000101&classification=NOT_LIVE'),
      ),
    ).toMatchObject({ legacyUserId: TG, classification: 'NOT_LIVE', test: 'ALL' });
    expect(legacyInvoiceFiltersOf(new URLSearchParams('classification=X')).classification).toBe(
      'ALL',
    );
    expect(legacyDebtFiltersOf(new URLSearchParams('state=ALL&legacyUserId=7000000101'))).toEqual({
      state: 'ALL',
      legacyUserId: TG,
    });
    expect(legacyDebtFiltersOf(new URLSearchParams('state=NOPE')).state).toBe('PENDING_REVIEW');
  });

  it('/legacy-services opens on the outcome the report linked', async () => {
    act(() =>
      navigate('/legacy-services?outcome=NO_PANEL&reviewState=ALL', { replace: true, force: true }),
    );
    const api = stubApi([]);
    renderPage(
      <LegacyServicesPage
        denied={false}
        mayDecide={false}
        mayViewPanels={false}
        mayViewArchive={false}
      />,
    );
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.url.includes('/legacy-services?') &&
            call.url.includes('outcome=NO_PANEL') &&
            !call.url.includes('reviewState='),
        ),
      ).toBe(true),
    );
  });

  it('/legacy-invoices sends the owner filter only to a PII reader', async () => {
    act(() => navigate(`/legacy-invoices?legacyUserId=${TG}`, { replace: true, force: true }));
    const api = stubApi([]);
    const pii = renderPage(<LegacyInvoicesPage denied={false} mayViewPii />);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes(`legacyUserId=${TG}`))).toBe(true),
    );
    pii.unmount();
    const before = api.calls.length;
    renderPage(<LegacyInvoicesPage denied={false} mayViewPii={false} />);
    await waitFor(() => expect(api.calls.length).toBeGreaterThan(before));
    expect(api.calls.slice(before).some((call) => call.url.includes('legacyUserId'))).toBe(false);
  });

  it('/legacy-debts opens on the state and owner the link named', async () => {
    act(() =>
      navigate(`/legacy-debts?state=ALL&legacyUserId=${TG}`, { replace: true, force: true }),
    );
    const api = stubApi([]);
    renderPage(<LegacyDebtsPage denied={false} mayDecide={false} />);
    await waitFor(() =>
      expect(
        api.calls.some(
          (call) =>
            call.url.includes(`legacyUserId=${TG}`) && !call.url.includes('state=PENDING_REVIEW'),
        ),
      ).toBe(true),
    );
  });
});
