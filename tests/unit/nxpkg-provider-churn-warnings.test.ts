import { describe, expect, it } from 'vitest';
import {
  LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN,
  LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED,
  legacyMigrationDryRunInventoryIncomplete,
} from '@nexa/contracts';
import {
  dryRunReportOf,
  providerChurnWarnings,
  providerIncomplete,
  providerWarnings,
} from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';

// A production RickPanel that keeps selling while it is read is decided one needed username at
// a time. Such a read is `complete: true` with a `resolution`: it is reported as churn, never as
// an incomplete panel, and what it could not decide blocks through the services category.

const report = (panels: unknown[]) =>
  ({ verdict: 'DRY_RUN', sections: { provider: { panels } } }) as never;

const resolution = (overrides: Record<string, unknown> = {}) => ({
  mode: 'TARGETED',
  reason: 'TOTAL_CHANGED',
  needed: 10,
  present: 9,
  absent: 1,
  collisions: 0,
  unresolved: 0,
  walks: 2,
  gapFree: true,
  ...overrides,
});

describe('providerChurnWarnings', () => {
  it('counts the churned panels and their reasons; nothing for a still panel', () => {
    expect(
      providerChurnWarnings(
        report([
          { complete: true, reason: null, resolution: resolution() },
          { complete: true, reason: null, resolution: resolution({ walks: 3 }) },
          {
            complete: true,
            reason: null,
            resolution: resolution({ reason: 'WALKS_DIFFER' }),
          },
          { complete: true, reason: null, resolution: null },
          { complete: true, reason: null },
        ]),
      ),
    ).toEqual([
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: 3 },
      { code: 'PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED', count: 2 },
      { code: 'PROVIDER_INVENTORY_CHURN:WALKS_DIFFER', count: 1 },
    ]);
    expect(providerChurnWarnings(report([{ complete: true, reason: null }]))).toEqual([]);
    expect(providerChurnWarnings({ sections: {} } as never)).toEqual([]);
  });

  it('sums the unresolved names', () => {
    expect(
      providerChurnWarnings(
        report([
          { complete: true, resolution: resolution({ unresolved: 2, gapFree: false }) },
          { complete: true, resolution: resolution({ unresolved: 3, gapFree: false }) },
        ]),
      ),
    ).toEqual([
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: 2 },
      { code: 'PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED', count: 2 },
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_UNRESOLVED, count: 5 },
    ]);
  });

  it('a malformed resolution: its reason is UNKNOWN and its numbers are ignored, never echoed', () => {
    const warnings = providerChurnWarnings(
      report([
        {
          complete: true,
          resolution: resolution({
            reason: 'user alice changed',
            lookups: -1,
            unresolved: 1.5,
          }),
        },
        {
          complete: true,
          resolution: resolution({
            reason: 42,
            lookups: Number.MAX_SAFE_INTEGER + 1,
            unresolved: '7',
          }),
        },
        { complete: true, resolution: resolution({ reason: 'A'.repeat(41), lookups: NaN }) },
        // Not an object: no resolution at all.
        { complete: true, resolution: 'TARGETED' },
        { complete: true, resolution: [1, 2] },
      ]),
    );
    expect(warnings).toEqual([
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: 3 },
      { code: 'PROVIDER_INVENTORY_CHURN:UNKNOWN', count: 3 },
    ]);
    expect(JSON.stringify(warnings)).not.toContain('alice');
  });
});

describe('a churned panel is not an incomplete one', () => {
  const churned = { complete: true, reason: null, resolution: resolution() };

  it('providerIncomplete does not count it, and still fails closed on anything not complete', () => {
    expect(providerIncomplete(report([churned]))).toBe(0);
    expect(
      providerIncomplete(report([churned, { complete: false, reason: 'TIMEOUT' }, null])),
    ).toBe(2);
    // A resolution never makes an incomplete read complete.
    expect(
      providerIncomplete(
        report([{ complete: false, reason: 'TOTAL_CHANGED', resolution: resolution() }]),
      ),
    ).toBe(1);
  });

  it('the contract rule does not block on churn alone, and still blocks on INVENTORY_INCOMPLETE', () => {
    const warnings = providerWarnings(report([churned]));
    expect(warnings.map((w) => w.code)).not.toContain('PROVIDER_INVENTORY_INCOMPLETE');
    expect(legacyMigrationDryRunInventoryIncomplete(warnings)).toBe(0);

    // A needed name left unresolved: its invoice is the services category INVENTORY_INCOMPLETE.
    const unresolved = providerWarnings(
      report([{ ...churned, resolution: resolution({ unresolved: 1 }) }]),
    );
    expect(legacyMigrationDryRunInventoryIncomplete(unresolved)).toBe(0);
    expect(
      legacyMigrationDryRunInventoryIncomplete([
        ...unresolved,
        { code: 'INVENTORY_INCOMPLETE', count: 1 },
      ]),
    ).toBe(1);
  });

  it('the dry run report carries the churn beside an incomplete panel, each under its own code', () => {
    const warnings = dryRunReportOf(
      report([churned, { complete: false, reason: 'TIMEOUT' }]),
      { wallet: { currency: 'IRT' } } as never,
      null,
      null,
      [],
      {
        invoiceArchiveRows: 0,
        holdChangedCategory: null,
        converterTotalsAbsent: false,
        inventoryVerdict: 'COMPLETE',
        tables: [],
        coverage: null,
      },
    ).warnings;
    // The report's warnings are sorted by code.
    expect(warnings).toEqual([
      { code: LEGACY_MIGRATION_PROVIDER_INVENTORY_CHURN, count: 1 },
      { code: 'PROVIDER_INVENTORY_CHURN:TOTAL_CHANGED', count: 1 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE', count: 1 },
      { code: 'PROVIDER_INVENTORY_INCOMPLETE:TIMEOUT', count: 1 },
    ]);
    expect(legacyMigrationDryRunInventoryIncomplete(warnings)).toBe(1);
  });
});
