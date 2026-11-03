import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import { parsePanelMapping } from '../../apps/api/src/modules/platform/legacy-importer/application/panel-mapping';
import {
  planLegacyImport,
  planTalliesDigest,
  type LegacyPlan,
} from '../../apps/api/src/modules/platform/legacy-importer/application/plan';
import {
  DEFAULT_DEMOTION_CAP,
  approvedAdoptionsOf,
  demotionCap,
  demotionsAgainst,
  demotionsSection,
  type ApprovedAdoption,
} from '../../apps/api/src/modules/platform/legacy-importer/application/demotions';
import { inventoryHeldDecision } from '../../apps/api/src/modules/platform/legacy-importer/application/decisions';
import type { LegacyInventoryRead } from '../../apps/api/src/modules/platform/legacy-importer/application/ports';
import { readFromSession } from '../../apps/api/src/modules/platform/legacy-importer/application/source-snapshot';
import { FixtureLegacySourceConnector } from '../../apps/api/src/modules/platform/legacy-importer/infrastructure/fixture-legacy-source';
import { mismatchCounts } from '../../apps/api/src/modules/platform/legacy-migration/infrastructure/nxpkg-migration-adapters';
import { buildSyntheticLegacyDataset } from '../fixtures/legacy/synthetic-legacy';
import { syntheticInventories, syntheticMappingFile } from '../fixtures/legacy/synthetic-support';

/**
 * NEXA v096 PR-1 — demotions at apply (`demotions.ts`). The approved dry run's plan and the
 * apply's plan over the SAME synthetic package, the panel read being the only thing that moves:
 * a demotion (an approved adoption the live panel lost) is applied; anything else — a
 * promotion, another category, another owner, a wallet figure, a tampered approval — is not.
 * SYNTHETIC data only.
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

const full = () => syntheticInventories(PANEL_A, PANEL_B);

/** A panel's read with accounts gone (deleted or expired on the panel between the two reads). */
function without(...names: string[]): Map<string, LegacyInventoryRead> {
  return withoutOn(full(), PANEL_A, names);
}

function withoutOn(
  inventories: Map<string, LegacyInventoryRead>,
  panelId: string,
  names: readonly string[],
): Map<string, LegacyInventoryRead> {
  const read = inventories.get(panelId);
  if (read === undefined || !read.ok || !read.complete) throw new Error('fixture');
  const usernames = new Map(read.index.usernames);
  for (const name of names) usernames.delete(name.toLowerCase());
  inventories.set(panelId, { ...read, index: { panelId, usernames }, accounts: usernames.size });
  return inventories;
}

function eligibleKey(plan: LegacyPlan, name: string): string {
  const found = plan.services.find(
    (s) =>
      s.decision.category === 'ADOPTION_ELIGIBLE' &&
      s.decision.providerUsername.toLowerCase() === name.toLowerCase(),
  );
  if (found === undefined) throw new Error('fixture');
  return found.invoice.idInvoice;
}

/** `plan` with one invoice decided otherwise and its category tally moved with it. */
function decidedAs(
  plan: LegacyPlan,
  key: string,
  decision: LegacyPlan['services'][number]['decision'],
): LegacyPlan {
  const categories = { ...plan.tallies.services.categories };
  const services = plan.services.map((s) => {
    if (s.invoice.idInvoice !== key) return s;
    categories[s.decision.category] -= 1;
    categories[decision.category] += 1;
    return { invoice: s.invoice, decision };
  });
  return {
    ...plan,
    services,
    tallies: { ...plan.tallies, services: { ...plan.tallies.services, categories } },
  };
}

async function approved() {
  const dry = await planWith(full());
  return { dry, adoptions: approvedAdoptionsOf(dry.services), digest: planTalliesDigest(dry) };
}

describe('demotions at apply: only the safe direction is applied', () => {
  it('an approved adoption whose account is gone is a DEMOTION to PROVIDER_MISSING: the apply runs its own plan, the list names the invoice and the panel account', async () => {
    const { dry, adoptions, digest } = await approved();
    const apply = await planWith(without('svc_a1'));
    expect(planTalliesDigest(apply)).not.toBe(digest);
    const verdict = demotionsAgainst(apply, adoptions, digest);
    expect(verdict.kind).toBe('DEMOTED');
    if (verdict.kind !== 'DEMOTED') return;
    expect(verdict.demotions).toEqual([
      {
        invoice: eligibleKey(dry, 'svc_a1'),
        panelId: PANEL_A,
        providerUsername: 'svc_a1',
        to: 'PROVIDER_MISSING',
      },
    ]);
    // Imported exactly as a dry-run PROVIDER_MISSING: the apply's own decision is kept.
    expect(verdict.plan.services).toBe(apply.services);
    expect(verdict.plan.tallies).toBe(apply.tallies);
  });

  it('an approved adoption whose name is now UNRESOLVED is demoted and HELD — the inventory hold’s own decision', async () => {
    const { dry, adoptions, digest } = await approved();
    const key = eligibleKey(dry, 'svc_a1');
    const fresh = { category: 'INVENTORY_INCOMPLETE' as const, map: null };
    const apply = decidedAs(dry, key, fresh);
    const verdict = demotionsAgainst(apply, adoptions, digest);
    expect(verdict.kind).toBe('DEMOTED');
    if (verdict.kind !== 'DEMOTED') return;
    expect(verdict.demotions.map((d) => [d.invoice, d.to])).toEqual([
      [key, 'INVENTORY_INCOMPLETE'],
    ]);
    const held = verdict.plan.services.find((s) => s.invoice.idInvoice === key);
    expect(held?.decision).toEqual(inventoryHeldDecision());
  });

  it('a PROMOTION (PROVIDER_MISSING at approval, eligible now) is not a demotion', async () => {
    const dry = await planWith(without('svc_a1'));
    const apply = await planWith(full());
    expect(
      demotionsAgainst(apply, approvedAdoptionsOf(dry.services), planTalliesDigest(dry)),
    ).toEqual({ kind: 'NOT_DEMOTIONS', demotions: 0 });
  });

  it('a demotion BESIDE a promotion is refused: the restored plan is not the approved one', async () => {
    // Approved: svc_a1 gone (PROVIDER_MISSING), svc_b1 adopted. Apply: svc_a1 back, svc_b1 gone.
    const dry = await planWith(without('svc_a1'));
    const apply = await planWith(withoutOn(full(), PANEL_B, ['svc_b1']));
    const verdict = demotionsAgainst(
      apply,
      approvedAdoptionsOf(dry.services),
      planTalliesDigest(dry),
    );
    expect(verdict).toEqual({ kind: 'NOT_DEMOTIONS', demotions: 1 });
    // The same demotion alone is applied.
    const alone = await planWith(withoutOn(without('svc_a1'), PANEL_B, ['svc_b1']));
    expect(
      demotionsAgainst(alone, approvedAdoptionsOf(dry.services), planTalliesDigest(dry)).kind,
    ).toBe('DEMOTED');
  });

  it('the direction guard: an approved adoption decided ANY other category (a second spelling, an ownership dispute) is not a demotion', async () => {
    const { dry, adoptions, digest } = await approved();
    const key = eligibleKey(dry, 'svc_a1');
    for (const category of [
      'USERNAME_CASE_COLLISION',
      'AMBIGUOUS_OWNERSHIP',
      'NO_PANEL',
    ] as const) {
      const verdict = demotionsAgainst(
        decidedAs(dry, key, { category, map: null }),
        adoptions,
        digest,
      );
      expect(verdict, category).toEqual({ kind: 'NOT_DEMOTIONS', demotions: 0 });
    }
  });

  it('a demotion beside ANOTHER OWNER on an adoption is refused', async () => {
    const { dry, adoptions, digest } = await approved();
    const apply = await planWith(without('svc_a1'));
    const other = apply.services.find((s) => s.decision.category === 'ADOPTION_ELIGIBLE');
    if (other === undefined || other.decision.category !== 'ADOPTION_ELIGIBLE')
      throw new Error('fixture');
    const moved = decidedAs(apply, other.invoice.idInvoice, {
      ...other.decision,
      telegramUserId: '999999999',
    });
    expect(demotionsAgainst(moved, adoptions, digest)).toEqual({
      kind: 'NOT_DEMOTIONS',
      demotions: 1,
    });
    expect(dry.tallies.services.categories.ADOPTION_ELIGIBLE).toBeGreaterThan(1);
  });

  it('a demotion beside a BALANCE change is refused: money must match the approval exactly', async () => {
    const { adoptions, digest } = await approved();
    const apply = await planWith(without('svc_a1'));
    const wallet = apply.tallies.wallet;
    const moved: LegacyPlan = {
      ...apply,
      tallies: {
        ...apply.tallies,
        wallet: {
          ...wallet,
          legacySumMinor: wallet.legacySumMinor + 1n,
          positive: { ...wallet.positive, sumMinor: wallet.positive.sumMinor + 1n },
        },
      },
    };
    expect(demotionsAgainst(moved, adoptions, digest)).toEqual({
      kind: 'NOT_DEMOTIONS',
      demotions: 1,
    });
  });

  it('a tampered approval cannot widen it: an adoption the dry run never made is refused', async () => {
    const dry = await planWith(without('svc_a1'));
    const digest = planTalliesDigest(dry);
    const full = await planWith(syntheticInventories(PANEL_A, PANEL_B));
    const forged: ApprovedAdoption[] = approvedAdoptionsOf(full.services);
    // The forged list "approves" svc_a1; the apply sees it gone — a demotion of nothing approved.
    const verdict = demotionsAgainst(dry, forged, digest);
    expect(verdict.kind).toBe('NOT_DEMOTIONS');
  });
});

describe('the demotion cap', () => {
  it('is the larger of 50 and 0.5 % of the approved adoptable services, rounded down', () => {
    expect(DEFAULT_DEMOTION_CAP).toEqual({ minServices: 50, basisPoints: 50 });
    expect(demotionCap(12_123, DEFAULT_DEMOTION_CAP)).toBe(60);
    expect(demotionCap(10_000, DEFAULT_DEMOTION_CAP)).toBe(50);
    expect(demotionCap(10_199, DEFAULT_DEMOTION_CAP)).toBe(50);
    expect(demotionCap(10_200, DEFAULT_DEMOTION_CAP)).toBe(51);
    expect(demotionCap(3, DEFAULT_DEMOTION_CAP)).toBe(50);
    expect(demotionCap(3, { minServices: 0, basisPoints: 0 })).toBe(0);
  });

  it('the section is sorted by invoice and names each invoice and its panel account', () => {
    expect(
      demotionsSection(
        [
          { invoice: 'b2', panelId: 'p', providerUsername: 'u2', to: 'PROVIDER_MISSING' },
          { invoice: 'a1', panelId: 'p', providerUsername: 'u1', to: 'INVENTORY_INCOMPLETE' },
        ],
        50,
        2,
      ),
    ).toEqual({
      count: 2,
      cap: 50,
      approvedAdoptable: 2,
      entries: [
        { legacyInvoiceId: 'a1', panelId: 'p', panelUsername: 'u1', to: 'INVENTORY_INCOMPLETE' },
        { legacyInvoiceId: 'b2', panelId: 'p', panelUsername: 'u2', to: 'PROVIDER_MISSING' },
      ],
    });
  });

  it('a refusal over the cap keeps its demotion counts beside the moved categories', () => {
    const out = mismatchCounts(
      { sections: [], warnings: [{ code: 'PROVIDER_MISSING', count: 2 }] } as never,
      { 'apply:services:PROVIDER_MISSING': 3, 'demotions:count': 1, 'demotions:cap': 0 },
    );
    expect(out).toEqual(
      expect.arrayContaining([
        { code: 'dryrun:services:PROVIDER_MISSING', count: 2 },
        { code: 'apply:services:PROVIDER_MISSING', count: 3 },
        { code: 'demotions:count', count: 1 },
        { code: 'demotions:cap', count: 0 },
      ]),
    );
  });
});
