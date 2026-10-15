import { describe, expect, it } from 'vitest';
import { legacyMigrationDryRunInventoryIncomplete } from '@nexa/contracts';
import { inventoryReadFailed } from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import {
  providerIncomplete,
  providerWarnings,
} from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';

// Review H, F1: a per-name read with NO decision walk (`gapFree: false`) decided nothing — every
// needed name is UNRESOLVED because the list itself could not be proven gap-free (e.g. a
// RickPanel whose rows carry no `created_at`: `NO_CREATION_TIME`, cause `NO_DECISION_WALK`).
// That is a whole-panel read failure in substance. It must block like one, not quarantine the
// whole panel's invoices and let a production-like approval through (a quarantined invoice can
// never be adopted after the import: service-review.md §4b is not built).

const noDecisionWalk = {
  mode: 'TARGETED',
  reason: 'NO_CREATION_TIME',
  needed: 3,
  present: 0,
  absent: 0,
  collisions: 0,
  unresolved: 3,
  walks: 3,
  gapFree: false,
} as const;

const panel = {
  panelId: 'p1',
  complete: false,
  reason: 'UNRESOLVED',
  resolution: noDecisionWalk,
};

describe('review H F1 — a per-name read that decided nothing is a failed read', () => {
  it('importer gate (inventoryReadFailed)', () => {
    expect(inventoryReadFailed(panel as never)).toBe(true);
  });

  it('dry-run report → approval rule', () => {
    const report = { verdict: 'DRY_RUN', sections: { provider: { panels: [panel] } } } as never;
    expect(providerIncomplete(report)).toBe(1);
    // Even with a hold covering all 3 invoices, the approval must be refused.
    const warnings = [...providerWarnings(report), { code: 'INVENTORY_INCOMPLETE', count: 3 }];
    expect(
      legacyMigrationDryRunInventoryIncomplete(warnings, {
        version: 1,
        invoices: 3,
        digest: 'a'.repeat(64),
      }),
    ).toBeGreaterThan(0);
  });
});
