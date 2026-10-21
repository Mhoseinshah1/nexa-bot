import { describe, expect, it } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import {
  LegacyInvoiceOutcomes,
  invoiceGroupOf,
  invoiceReason,
} from '../../apps/web/src/pages/legacy-invoice-outcomes';
import { mirzaAccess } from '../../apps/web/src/pages/recovery-mirza';
import { LEGACY_SERVICE_OUTCOMES, type LegacyServiceOutcome } from '@nexa/contracts';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage, stubApi } from './harness';

/** Round 5C-2 D3: the read-only outcome of each old invoice on the one-click import page. */

const AT = '2026-10-01T00:00:00.000Z';

function candidate(n: number, outcome: LegacyServiceOutcome, blocker: string | null = null) {
  return {
    id: `019250ab-cdef-7012-8345-6789abcd${String(n).padStart(4, '0')}`,
    invoiceKey: `INV-${String(n)}`,
    outcome,
    blocker,
    reviewState: 'OPEN',
    panelCode: null,
    productCode: null,
    evidence: {
      panelCodeClass: 'MAPPED',
      mappedPanelId: null,
      customer: 'IMPORTED',
      holders: [],
      incompletePanels: [],
      product: { path: 'NONE', productId: null, resolved: false },
      claims: 1,
    },
    archiveId: null,
    serviceId: null,
    approvedPanelId: null,
    lastApprovalRefusal: null,
    decisionReason: null,
    decidedByAdminId: null,
    decidedAt: null,
    runId: '019250ab-cdef-7012-8345-6789abcdef99',
    sourceFingerprint: 'f',
    invoiceChecksum: 'c',
    synthetic: false,
    observedAt: null,
    version: 1,
    firstDecidedAt: AT,
    updatedAt: AT,
  };
}

describe('the import report per old invoice', () => {
  it('groups every outcome into migrated, archived or not on the panel', () => {
    expect(invoiceGroupOf('ADOPTED')).toBe('MIGRATED');
    expect(invoiceGroupOf('ALREADY_ADOPTED')).toBe('MIGRATED');
    expect(invoiceGroupOf('PROVIDER_MISSING')).toBe('NOT_ON_PANEL');
    expect(invoiceGroupOf('NO_PANEL')).toBe('NOT_ON_PANEL');
    for (const outcome of LEGACY_SERVICE_OUTCOMES) {
      expect(['MIGRATED', 'ARCHIVED', 'NOT_ON_PANEL']).toContain(invoiceGroupOf(outcome));
    }
    expect(invoiceGroupOf('ORPHAN')).toBe('ARCHIVED');
  });

  it('names the reason: the outcome, plus the importer blocker when it differs', () => {
    expect(invoiceReason(candidate(1, 'ORPHAN') as never)).toBe(t('web.lsr_outcome_orphan'));
    expect(invoiceReason(candidate(1, 'ORPHAN', 'NOT_LIVE') as never)).toBe(
      `${t('web.lsr_outcome_orphan')} - ${t('web.lsr_refusal_not_live')}`,
    );
  });

  it('lists each invoice with its group and reason, pages by keyset and searches by invoice id', async () => {
    const first = [
      candidate(1, 'ADOPTED'),
      candidate(2, 'PROVIDER_MISSING'),
      candidate(3, 'ORPHAN'),
    ];
    const api = stubApi([
      {
        url: '/legacy-services?invoiceId=INV-3',
        body: { candidates: [first[2]], nextCursor: null },
      },
      {
        url: '/legacy-services?after=',
        body: { candidates: [candidate(4, 'ADOPTED')], nextCursor: null },
      },
      { url: '/legacy-services', body: { candidates: first, nextCursor: first[2]!.id } },
    ]);
    renderPage(<LegacyInvoiceOutcomes />);
    const table = await screen.findByRole('table');
    await within(table).findByText('INV-1');
    const rowOf = (key: string) => within(table).getByText(key).closest('tr')!;
    expect(within(rowOf('INV-1')).getAllByText(t('web.lio_group_migrated'))[0]).toBeInTheDocument();
    expect(within(rowOf('INV-2')).getByText(t('web.lio_group_not_on_panel'))).toBeInTheDocument();
    expect(within(rowOf('INV-3')).getByText(t('web.lio_group_archived'))).toBeInTheDocument();
    expect(within(rowOf('INV-3')).getByText(t('web.lsr_outcome_orphan'))).toBeInTheDocument();
    // Read-only: no control that decides anything.
    expect(within(table).queryAllByRole('button')).toHaveLength(0);

    // Keyset paging passes the last id as `after`.
    fireEvent.click(screen.getByRole('button', { name: t('web.page_newer') }));
    await screen.findByText('INV-4');
    expect(api.calls.some((call) => call.url.includes(`after=${first[2]!.id}`))).toBe(true);

    // Search by the old invoice id.
    fireEvent.change(screen.getByLabelText(t('web.lio_search')), { target: { value: 'INV-3' } });
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.includes('invoiceId=INV-3'))).toBe(true),
    );
    cleanup();
  });

  it('says so when nothing matches', async () => {
    stubApi([{ url: '/legacy-services', body: { candidates: [], nextCursor: null } }]);
    renderPage(<LegacyInvoiceOutcomes />);
    expect(await screen.findByText(t('web.lio_empty'))).toBeInTheDocument();
    cleanup();
  });

  it('is offered only to a reader of legacy.services.view', () => {
    expect(mirzaAccess(['legacy.migration.view']).mayViewInvoices).toBe(false);
    expect(mirzaAccess(['legacy.services.view']).mayViewInvoices).toBe(true);
  });
});
