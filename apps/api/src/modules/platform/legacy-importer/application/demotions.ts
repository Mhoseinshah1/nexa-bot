import {
  LEGACY_IMPORT_DEMOTION_CAP_BASIS_POINTS_DEFAULT,
  LEGACY_IMPORT_DEMOTION_CAP_MIN_SERVICES_DEFAULT,
  LEGACY_IMPORT_DEMOTION_TARGETS,
  type LegacyImportDemotionTarget,
} from '@nexa/contracts';
import { inventoryHeldDecision, type ServiceCandidateCategory } from './decisions.js';
import {
  planDigestOf,
  serviceDecisionRow,
  servicesDecisionDigestOfRows,
  type LegacyPlan,
  type PlannedService,
  type PlanTallies,
} from './plan.js';

/**
 * NEXA v096 PR-1 — demotions at apply (`docs/legacy-migration/nxpkg-importer.md` §Demotions at
 * apply). PURE.
 *
 * An apply re-reads the live panel. Between the owner's approval and the apply the panel can
 * expire or delete an account on its own (Mirza still selling, the panel's own lifecycle), and
 * one such account used to throw the whole import away (`DRY_RUN_MISMATCH`). The rule now:
 *
 * - a DEMOTION is accepted: an invoice the APPROVED dry run adopted (`ADOPTION_ELIGIBLE`) that
 *   the apply finds gone (`PROVIDER_MISSING`, imported as an ended service exactly as a dry-run
 *   `PROVIDER_MISSING` is) or unresolved (`INVENTORY_INCOMPLETE`, held exactly as the inventory
 *   hold holds it: history and an OPEN review candidate, never adopted);
 * - ANYTHING else still refuses before any write: a promotion, an adoption of an account the
 *   approval never saw, another owner, panel, spelling or product, and every customer, wallet,
 *   debt, trial and shape figure.
 *
 * How "anything else" is decided, without trusting the stored list: every demoted invoice is
 * put back as the approved decision it came from, the tallies it moved are moved back, and the
 * plan digest of that RESTORED plan must be the approved digest exactly. The digest binds every
 * live invoice's decision and every tally (`planTalliesDigest`), so the only way to meet it is a
 * plan that differs from the approved one in nothing but the demotions — and a stored row that
 * is not the approved decision cannot meet it either.
 */

/**
 * One adoption of the approved dry run, as the dry run records it (`legacy_import_run_inputs.
 * approved_adoptions`): the eligible row of `servicesDecisionDigest` without its category —
 * invoice, panel, the panel's exact spelling, product path and reference, the customer.
 */
export type ApprovedAdoption = readonly [
  invoice: string,
  panelId: string,
  providerUsername: string,
  productKind: string,
  productRef: string,
  telegramUserId: string,
];

/** One accepted demotion: the legacy invoice, the account it would have adopted, and to what. */
export interface PlanDemotion {
  readonly invoice: string;
  readonly panelId: string;
  readonly providerUsername: string;
  readonly to: LegacyImportDemotionTarget;
}

/** The cap setting (`LEGACY_IMPORT_DEMOTION_CAP_SETTING_KEYS`). */
export interface DemotionCapSetting {
  readonly minServices: number;
  readonly basisPoints: number;
}

export const DEFAULT_DEMOTION_CAP: DemotionCapSetting = {
  minServices: LEGACY_IMPORT_DEMOTION_CAP_MIN_SERVICES_DEFAULT,
  basisPoints: LEGACY_IMPORT_DEMOTION_CAP_BASIS_POINTS_DEFAULT,
};

/** The approved adoptions of a plan, sorted by invoice: what a dry run records. */
export function approvedAdoptionsOf(services: readonly PlannedService[]): ApprovedAdoption[] {
  const out: ApprovedAdoption[] = [];
  for (const s of services) {
    if (s.decision.category !== 'ADOPTION_ELIGIBLE') continue;
    const [invoice, , panelId, providerUsername, productKind, productRef, telegramUserId] =
      serviceDecisionRow(s);
    out.push([
      invoice ?? '',
      panelId ?? '',
      providerUsername ?? '',
      productKind ?? '',
      productRef ?? '',
      telegramUserId ?? '',
    ]);
  }
  return out.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

/** Whether a stored value is a list of approved adoptions (the column is read back as JSON). */
export function isApprovedAdoptions(value: unknown): value is ApprovedAdoption[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.length === 6 &&
        row.every((cell: unknown) => typeof cell === 'string'),
    )
  );
}

/**
 * The cap: the larger of `minServices` and `basisPoints` / 10 000 of the approved adoptable
 * services, rounded down (the smaller cap of the two readings of a fraction).
 */
export function demotionCap(approvedAdoptable: number, setting: DemotionCapSetting): number {
  return Math.max(
    setting.minServices,
    Math.floor((approvedAdoptable * setting.basisPoints) / 10_000),
  );
}

const TARGETS: ReadonlySet<ServiceCandidateCategory> = new Set(LEGACY_IMPORT_DEMOTION_TARGETS);

export type DemotionVerdict =
  /** The plan IS the approved one but for these demotions; `plan` is the one to apply. */
  | {
      readonly kind: 'DEMOTED';
      readonly plan: LegacyPlan;
      readonly demotions: readonly PlanDemotion[];
    }
  /**
   * Not explained by demotions (`demotions`: how many demotions were found beside whatever
   * else moved, 0 when none): the plan is not the approved one, `DRY_RUN_MISMATCH`.
   */
  | { readonly kind: 'NOT_DEMOTIONS'; readonly demotions: number };

/**
 * Whether `plan` (the apply's) differs from the approved dry run (`approved`, `approvedDigest`)
 * by demotions ONLY. The direction guard: a row is a demotion only when the approval ADOPTED
 * the invoice and the apply decides it one of `LEGACY_IMPORT_DEMOTION_TARGETS`; every other
 * difference is left in place and fails the restored digest.
 */
export function demotionsAgainst(
  plan: LegacyPlan,
  approved: readonly ApprovedAdoption[],
  approvedDigest: string,
): DemotionVerdict {
  const byInvoice = new Map(approved.map((a) => [a[0], a]));
  const demotions: PlanDemotion[] = [];
  let namedRestored = 0;
  const rows = plan.services.map((s) => {
    const adopted = byInvoice.get(s.invoice.idInvoice);
    const category = s.decision.category;
    if (adopted === undefined || !TARGETS.has(category)) return serviceDecisionRow(s);
    demotions.push({
      invoice: adopted[0],
      panelId: adopted[1],
      providerUsername: adopted[2],
      to: category as LegacyImportDemotionTarget,
    });
    if (adopted[3] === 'NAMED_PRODUCT') namedRestored += 1;
    const [invoice, panelId, providerUsername, productKind, productRef, telegramUserId] = adopted;
    return [
      invoice,
      'ADOPTION_ELIGIBLE',
      panelId,
      providerUsername,
      productKind,
      productRef,
      telegramUserId,
    ];
  });
  if (demotions.length === 0) return { kind: 'NOT_DEMOTIONS', demotions: 0 };
  const restored = restoredTallies(plan.tallies, demotions, namedRestored);
  if (
    planDigestOf(restored, servicesDecisionDigestOfRows(rows), plan.inventoryHold) !==
    approvedDigest
  ) {
    return { kind: 'NOT_DEMOTIONS', demotions: demotions.length };
  }
  // The plan the apply executes: a gone account is the PROVIDER_MISSING the read decided; an
  // unresolved name is held exactly as the approved inventory hold holds its own invoices.
  const held = new Set(
    demotions.filter((d) => d.to === 'INVENTORY_INCOMPLETE').map((d) => d.invoice),
  );
  const services =
    held.size === 0
      ? plan.services
      : plan.services.map((s) =>
          held.has(s.invoice.idInvoice)
            ? { invoice: s.invoice, decision: inventoryHeldDecision() }
            : s,
        );
  return { kind: 'DEMOTED', plan: { ...plan, services }, demotions };
}

/** The tallies as the approved dry run had them: each demoted invoice counted as adopted again. */
function restoredTallies(
  tallies: PlanTallies,
  demotions: readonly PlanDemotion[],
  namedRestored: number,
): PlanTallies {
  const categories = { ...tallies.services.categories };
  for (const d of demotions) {
    categories[d.to] -= 1;
    categories.ADOPTION_ELIGIBLE += 1;
  }
  return {
    ...tallies,
    products: {
      ...tallies.products,
      namedProductCandidates: tallies.products.namedProductCandidates + namedRestored,
    },
    services: { ...tallies.services, categories },
  };
}

/** The demotions as a report carries them (operator-only): sorted by invoice. */
export function demotionsSection(
  demotions: readonly PlanDemotion[],
  cap: number,
  approvedAdoptable: number,
) {
  return {
    count: demotions.length,
    cap,
    approvedAdoptable,
    entries: [...demotions]
      .sort((a, b) => (a.invoice < b.invoice ? -1 : a.invoice > b.invoice ? 1 : 0))
      .map((d) => ({
        legacyInvoiceId: d.invoice,
        panelId: d.panelId,
        panelUsername: d.providerUsername,
        to: d.to,
      })),
  };
}
