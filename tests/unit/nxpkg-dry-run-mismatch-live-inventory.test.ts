import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  planLegacyImport,
  planTalliesDigest,
  planTalliesRefusalCounts,
  type PlanTallies,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { providerIncomplete } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * `DRY_RUN_MISMATCH` at APPLY_IMPORT (Web Admin, `.nxpkg`) — the plan tallies digest is a
 * function of the package AND of a LIVE RickPanel inventory read that the dry run and the
 * import each make on their own (`LegacyImporterService.prepare` → `inventory.read`). None of
 * the seven cutover values binds that read (`inventoryFingerprint` is the legacy TABLE
 * inventory of the package), so the same package, the same NEXA state and the same approval
 * produce another digest whenever the panel's username set — or whether its double walk came
 * out complete — moved between the two reads. SYNTHETIC data only.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const PANEL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PANEL_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

async function planWith(inventories: ReadonlyMap<string, LegacyInventoryRead>) {
  const connector = new FixtureLegacySourceConnector(buildSyntheticLegacyDataset() as never);
  const snapshot = await readFromSession(connector.label, await connector.open());
  const mapping = parsePanelMapping(syntheticMappingFile(TENANT, PANEL_A, PANEL_B), TENANT);
  return planLegacyImport({
    snapshot,
    mapping,
    salesCurrency: 'IRT',
    existingCustomers: new Map(),
    existingOpenings: new Map(),
    trialOverrides: new Map(),
    trialDecided: new Set(),
    existingShapes: new Map(),
    tariffCandidates: [
      {
        id: 'p-30',
        status: 'ACTIVE',
        audience: 'EVERYONE',
        durationDays: 30,
        trafficBytes: 30n * 1024n ** 3n,
        price: money(200_000n, 'IRT'),
        panelBound: true,
        categoryStatus: 'ACTIVE',
      },
    ],
    inventories,
  } as never);
}

/** Panel A's read with one account gone (deleted on the panel between the two reads). */
function withoutAccount(name: string): Map<string, LegacyInventoryRead> {
  const inventories = syntheticInventories(PANEL_A, PANEL_B);
  const a = inventories.get(PANEL_A);
  if (a === undefined || !a.ok || !a.complete) throw new Error('fixture');
  const usernames = new Map(a.index.usernames);
  usernames.delete(name.toLowerCase());
  inventories.set(PANEL_A, {
    ...a,
    index: { panelId: PANEL_A, usernames },
    accounts: a.accounts - 1,
  });
  return inventories;
}

function incompleteA(reason: string): Map<string, LegacyInventoryRead> {
  const inventories = syntheticInventories(PANEL_A, PANEL_B);
  inventories.set(PANEL_A, { ok: true, complete: false, reason });
  return inventories;
}

/**
 * What the RickPanel read cannot move: customers, wallets and debts, trials, and the product
 * shapes. `products.namedProductCandidates` counts ELIGIBLE invoices, so it moves with them.
 */
function nonServiceTallies(t: PlanTallies) {
  const { namedProductCandidates: _eligibleDerived, ...products } = t.products;
  return { customers: t.customers, wallet: t.wallet, trials: t.trials, products };
}

describe('DRY_RUN_MISMATCH: the plan tallies digest follows the live RickPanel read', () => {
  it('is deterministic for identical inputs, whatever the inventory map order', async () => {
    const d1 = planTalliesDigest(await planWith(syntheticInventories(PANEL_A, PANEL_B)));
    const d2 = planTalliesDigest(await planWith(syntheticInventories(PANEL_A, PANEL_B)));
    const reversed = new Map([...syntheticInventories(PANEL_A, PANEL_B)].reverse());
    expect(d2).toBe(d1);
    expect(planTalliesDigest(await planWith(reversed))).toBe(d1);
  });

  it('dry run on an INCOMPLETE walk, import on a COMPLETE one: another digest, services only', async () => {
    const dry = await planWith(incompleteA('WALKS_DIFFER'));
    const apply = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    expect(dry.tallies.services.categories.INVENTORY_INCOMPLETE).toBeGreaterThan(0);
    expect(apply.tallies.services.categories.INVENTORY_INCOMPLETE).toBe(0);
    // The importer's own comparison (`applyClaimed`): not equal → DRY_RUN_MISMATCH.
    expect(planTalliesDigest(apply)).not.toBe(planTalliesDigest(dry));
    // Customers, wallets, debts, trials and shapes are untouched by the panel read.
    expect(nonServiceTallies(apply.tallies)).toEqual(nonServiceTallies(dry.tallies));
  });

  it('both reads complete, one account deleted on the panel in between: another digest', async () => {
    const dry = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const apply = await planWith(withoutAccount('svc_a1'));
    expect(apply.tallies.services.categories.ADOPTION_ELIGIBLE).toBe(
      dry.tallies.services.categories.ADOPTION_ELIGIBLE - 1,
    );
    expect(apply.tallies.services.categories.PROVIDER_MISSING).toBe(
      dry.tallies.services.categories.PROVIDER_MISSING + 1,
    );
    expect(planTalliesDigest(apply)).not.toBe(planTalliesDigest(dry));
    expect(nonServiceTallies(apply.tallies)).toEqual(nonServiceTallies(dry.tallies));
  });

  it('both reads incomplete (any reason): the SAME digest — the reason is not a tally', async () => {
    const dry = await planWith(incompleteA('TOTAL_CHANGED'));
    const apply = await planWith(incompleteA('WALKS_DIFFER'));
    expect(planTalliesDigest(apply)).toBe(planTalliesDigest(dry));
  });

  it('the refusal carries the import side of what moved: the categories and the incomplete panels', async () => {
    const dry = planTalliesRefusalCounts(await planWith(incompleteA('WALKS_DIFFER')));
    const apply = planTalliesRefusalCounts(await planWith(syntheticInventories(PANEL_A, PANEL_B)));
    expect(dry['apply:panels:inventory_incomplete']).toBe(1);
    expect(apply['apply:panels:inventory_incomplete']).toBe(0);
    expect(apply['apply:services:INVENTORY_INCOMPLETE']).toBe(0);
    expect(dry['apply:services:INVENTORY_INCOMPLETE']).toBeGreaterThan(0);
    // The money side is the same number on both sides: what moved is the panel read.
    for (const key of [
      'apply:customers:importable',
      'apply:wallet:positive',
      'apply:wallet:negative',
    ]) {
      expect(apply[key]).toBe(dry[key]);
    }
    // Counts only: every value a non-negative integer, every key a code (no id, no name).
    for (const [key, value] of Object.entries(apply)) {
      expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
      expect(key).toMatch(/^apply:[a-z_]+:[A-Za-z_]+$/u);
    }
  });
});

describe('PROVIDER_INVENTORY_INCOMPLETE: the dry run says its plan rests on an incomplete live read', () => {
  const report = (panels: unknown) => ({ sections: { provider: { panels } } }) as never;

  it('counts the production panels whose read was not complete', async () => {
    const dry = await planWith(incompleteA('TOTAL_CHANGED'));
    expect(providerIncomplete(report(dry.inventories))).toBe(1);
    const full = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    expect(providerIncomplete(report(full.inventories))).toBe(0);
  });

  it('is zero without a provider section, and never counts a panel read as complete', () => {
    expect(providerIncomplete({ sections: {} } as never)).toBe(0);
    expect(providerIncomplete(report([{ complete: 'yes' }, null, { complete: true }]))).toBe(2);
  });
});
