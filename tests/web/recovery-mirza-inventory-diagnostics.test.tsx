import { describe, expect, it } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  RICKPANEL_CHAIN_BREAKS,
  RICKPANEL_GAP_FREE_FAILURES,
  RICKPANEL_UNRESOLVED_CAUSES,
  type LegacyInventoryPanelDiagnostics,
} from '@nexa/contracts';
import { InventoryDiagnostics } from '../../apps/web/src/pages/recovery-mirza-inventory-diagnostics';
import { t, type WebKey } from '../../apps/web/src/i18n/web.fa';
import { formatNumber } from '../../apps/web/src/format';

/**
 * The dry run's `providerDiagnostics`, shown to the operator: why a RickPanel read left names
 * unresolved, cause by cause and walk by walk, with what to do. Synthetic counts only.
 */

const PANEL = '019600ab-cdef-7012-8345-6789abcd0401';

const walk = (
  overrides: Partial<LegacyInventoryPanelDiagnostics['walks'][number]> = {},
): LegacyInventoryPanelDiagnostics['walks'][number] => ({
  pages: 4,
  rowsFetched: 330,
  gapFree: false,
  decisive: false,
  sameOrderAsPrevious: null,
  failures: ['CREATED_ORDER'],
  firstFailure: { kind: 'CREATED_ORDER', pageIndex: 1 },
  overlapApplied: 10,
  learnedLimit: null,
  durationMs: 4_000,
  reportedTotalFirst: 300,
  reportedTotalLast: 301,
  reportedTotalMaxChange: 1,
  endedOffsetMinusTotal: 0,
  createdAt: {
    rowsWithout: 0,
    rowsUnparsable: 0,
    inversions: 1,
    maxInversionMs: 149_000,
    formats: [{ code: 'OFFSET', count: 300 }],
  },
  chainBreaks: [{ code: 'NO_COMMON_ROW', count: 1 }],
  ...overrides,
});

const diagnostics: LegacyInventoryPanelDiagnostics = {
  panelId: PANEL,
  reason: 'TOTAL_CHANGED',
  needed: 33_200,
  unresolved: 33_200,
  decisionWalk: null,
  unresolvedByCause: [
    { code: 'NO_DECISION_WALK', count: 33_198 },
    { code: 'BACKUP_TWO_SPELLINGS', count: 2 },
  ],
  walks: [walk(), walk({ sameOrderAsPrevious: true })],
};

describe('the dry run explains an unresolved RickPanel read', () => {
  it('nothing for an older report without the field, or an empty one', () => {
    const { container } = render(<InventoryDiagnostics report={{}} bindings={null} />);
    expect(container).toBeEmptyDOMElement();
    const empty = render(<InventoryDiagnostics report={{ providerDiagnostics: [] }} />);
    expect(empty.container).toBeEmptyDOMElement();
  });

  it('per panel (named by its legacy code): the causes with their remedy, the probe advice, and each walk', () => {
    render(
      <InventoryDiagnostics
        report={{ providerDiagnostics: [diagnostics] }}
        bindings={[{ codePanel: 'rick-main', panelId: PANEL }]}
      />,
    );
    expect(screen.getByText(t('web.mrz_diag_title'))).toBeInTheDocument();
    expect(screen.getByText('rick-main')).toBeInTheDocument();
    expect(
      screen.getByText(
        t('web.mrz_diag_panel_summary')
          .replace('{unresolved}', formatNumber(33_200))
          .replace('{needed}', formatNumber(33_200)),
        { exact: false },
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText('rick-main'));
    expect(
      screen.getByText(t('web.mrz_diag_cause_no_decision_walk'), { exact: false }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(t('web.mrz_diag_cause_backup_two_spellings'), { exact: false }),
    ).toBeInTheDocument();
    // created_at out of order cannot be mended by running again: the G6 probe is the remedy.
    expect(screen.getByText(t('web.mrz_diag_probe_title'))).toBeInTheDocument();
    expect(
      screen.getByText(t('web.mrz_diag_walk_title').replace('{n}', formatNumber(2))),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText(
        t('web.mrz_diag_first_failure_at')
          .replace('{page}', formatNumber(2))
          .replace('{what}', t('web.mrz_diag_failure_created_order')),
      ),
    ).toHaveLength(2);
    expect(
      screen.getAllByText(t('web.mrz_diag_break_no_common_row'), { exact: false }),
    ).toHaveLength(2);
  });

  it('no probe advice when every failure is one a later dry run can clear (deletion bursts)', () => {
    render(
      <InventoryDiagnostics
        report={{
          providerDiagnostics: [
            {
              ...diagnostics,
              unresolvedByCause: [{ code: 'LAST_NOT_DECISIVE', count: 3 }],
              walks: [walk({ failures: ['NOT_ENDED_AT_TOTAL'], firstFailure: null })],
            },
          ],
        }}
      />,
    );
    // Without a binding the panel is named by its id.
    fireEvent.click(screen.getByText(PANEL));
    expect(
      screen.getByText(t('web.mrz_diag_cause_last_not_decisive'), { exact: false }),
    ).toBeInTheDocument();
    expect(screen.queryByText(t('web.mrz_diag_probe_title'))).toBeNull();
  });

  it('every closed code has an operator sentence, and none tells the operator to stop selling', () => {
    const keys: WebKey[] = [
      ...RICKPANEL_UNRESOLVED_CAUSES.map((c) => `web.mrz_diag_cause_${c.toLowerCase()}` as WebKey),
      ...RICKPANEL_GAP_FREE_FAILURES.map(
        (f) => `web.mrz_diag_failure_${f.toLowerCase()}` as WebKey,
      ),
      ...RICKPANEL_CHAIN_BREAKS.map((b) => `web.mrz_diag_break_${b.toLowerCase()}` as WebKey),
      'web.mrz_diag_probe_body',
    ];
    for (const key of keys) {
      expect(t(key)).toBeTruthy();
      expect(t(key)).not.toMatch(/متوقف کنید/u);
    }
  });
});
