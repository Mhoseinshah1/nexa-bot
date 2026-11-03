import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import { legacyImportDemotionsSchema } from '@nexa/contracts';
import { DemotionsTable } from '../../apps/web/src/pages/recovery-mirza';
import { t } from '../../apps/web/src/i18n/web.fa';
import { renderPage } from './harness';

/**
 * NEXA v096 PR-1: the import result lists every approved adoptable service the apply demoted
 * because the live panel moved after the approved dry run — the legacy invoice id, the panel
 * username, and what it became. Operator-only.
 */
describe('the import result: demotions', () => {
  it('shows the count, the cap and each legacy invoice → panel username', () => {
    const demotions = legacyImportDemotionsSchema.parse({
      count: 2,
      cap: 50,
      approvedAdoptable: 12123,
      entries: [
        {
          legacyInvoiceId: 'a0000001',
          panelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          panelUsername: 'svc_a1',
          to: 'PROVIDER_MISSING',
        },
        {
          legacyInvoiceId: 'a0000002',
          panelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          panelUsername: 'svc_a2',
          to: 'INVENTORY_INCOMPLETE',
        },
      ],
    });
    renderPage(<DemotionsTable demotions={demotions} />);
    expect(screen.getAllByText(t('web.mrz_demotions_title')).length).toBeGreaterThan(0);
    expect(screen.getByText(t('web.mrz_demotions_hint'))).toBeTruthy();
    for (const text of ['a0000001', 'svc_a1', 'a0000002', 'svc_a2']) {
      expect(screen.getByText(text)).toBeTruthy();
    }
    expect(screen.getByText(t('web.mrz_demotion_provider_missing'))).toBeTruthy();
    expect(screen.getByText(t('web.mrz_demotion_inventory_incomplete'))).toBeTruthy();
  });

  it('a stored report is held to the contract: an unknown target is refused', () => {
    expect(
      legacyImportDemotionsSchema.safeParse({
        count: 1,
        cap: 50,
        approvedAdoptable: 1,
        entries: [{ legacyInvoiceId: 'x', panelId: 'p', panelUsername: 'u', to: 'ADOPTED' }],
      }).success,
    ).toBe(false);
  });
});
