import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from '@testing-library/react';
import { LEDGER_REASONS } from '@nexa/contracts';
import { LEGACY_SERVICE_OUTCOME_LABELS } from '../../apps/web/src/pages/legacy-service-labels';
import {
  LEDGER_REASON_LABELS,
  MIRZA_INVOICE_STATUS_LABELS,
  migrationCodeView,
  migrationSectionView,
  mirzaStatusLabel,
} from '../../apps/web/src/pages/mirza-labels';
import { t } from '../../apps/web/src/i18n/web.fa';
import { navigate } from '../../apps/web/src/router';

/**
 * After a Mirza import: Mirza's verbatim status labelled only where its writer is documented,
 * every ledger reason named, and the migration report's labels. SYNTHETIC values only.
 */

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => navigate('/', { replace: true, force: true }));
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

describe('the ledger reasons', () => {
  it('names every reason, and the migration opening balance as Mirza’s', () => {
    for (const reason of LEDGER_REASONS) {
      expect(t(LEDGER_REASON_LABELS[reason]), reason).toMatch(/[؀-ۿ]/u);
    }
    expect(new Set(LEDGER_REASONS.map((r) => LEDGER_REASON_LABELS[r])).size).toBe(
      LEDGER_REASONS.length,
    );
    expect(t(LEDGER_REASON_LABELS.MIGRATION_OPENING_BALANCE)).toContain('ربات قبلی');
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
      href: null,
    });
    // Round 4 B4: the review pages are retired, so nothing in the report links to them.
    expect(migrationCodeView('PRODUCT_NO_TARIFF', LEGACY_SERVICE_OUTCOME_LABELS).href).toBeNull();
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
