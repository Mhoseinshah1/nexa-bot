import {
  LEGACY_USER_STATUS_CLASSES,
  type LegacyTrialDecision,
  type LegacyUserStatusClass,
} from '@nexa/contracts';
import {
  legacyShapeKey,
  resolveCurrentTariff,
  type LegacyShapeInput,
  type LegacyShapeUnmappableReason,
  type TariffCandidate,
} from '../../../commerce/catalog/application/legacy-shape.js';
import { decideLegacyTrial } from '../../../commerce/trials/application/legacy-trial-eligibility.js';
import type { PanelInventoryIndex } from '../../legacy-import/application/legacy-service-matching.js';
import {
  INVENTORY_DERIVED_CATEGORIES,
  INVOICE_MAP_DECISIONS,
  SERVICE_CANDIDATE_CATEGORIES,
  inventoryHeldDecision,
  decideLegacyUser,
  decideServiceCandidate,
  legacyTelegramId,
  isQ1bPopulation,
  legacyIsAgent,
  needsHiddenShape,
  type LegacyUserDecision,
  type ServiceCandidateCategory,
  type ServiceCandidateDecision,
} from './decisions.js';
import { unmappedCodePanels, type PanelMapping } from './panel-mapping.js';
import type {
  LegacyInventoryDiagnostics,
  LegacyInventoryRead,
  LegacyInventoryResolution,
} from './ports.js';
import {
  sha256Hex,
  type LegacyInvoiceRow,
  type LegacySnapshot,
  type LegacyUserRow,
} from './source-snapshot.js';

/**
 * Migration P7 — the complete decision plan for one snapshot, PURE
 * (`docs/legacy-migration/importer.md` §Plan).
 *
 * `dry-run` is this plan, counted. `import` is this plan, applied phase by phase, each
 * phase through the existing service that owns its write. There is one function that
 * decides, so a dry run and the import it previews cannot disagree about a row.
 */

/**
 * What the openings phase will do for an importable user. Since owner decision 2026-10-17 a
 * negative balance is posted like a positive one, as a ledger DEBIT opening: the wallet holds
 * exactly the Mirza balance, and a negative one blocks purchase until it is topped up.
 */
export type OpeningPlan = 'POST' | 'ALREADY_POSTED' | 'ZERO_NO_ENTRY' | 'CONFLICT';
export const OPENING_PLANS: readonly OpeningPlan[] = [
  'POST',
  'ALREADY_POSTED',
  'ZERO_NO_ENTRY',
  'CONFLICT',
];
export type TrialPlan = LegacyTrialDecision | 'ALREADY_DECIDED';

export interface PlannedUser {
  readonly row: LegacyUserRow;
  readonly decision: LegacyUserDecision;
  /** The existing NEXA customer, when there is one. */
  readonly existingCustomerId: string | null;
  readonly opening: OpeningPlan | null;
  readonly trial: TrialPlan | null;
}

export interface PlannedShape {
  readonly key: string;
  readonly input: LegacyShapeInput;
  readonly custom: boolean;
  readonly existing: { readonly id: string; readonly tariffStatus: string } | null;
  readonly predictedTariff: 'MATCHED' | 'NO_CURRENT_TARIFF' | 'AMBIGUOUS_TARIFF';
  /** One of Q1b's productless shapes (compare with Q1b's MAPPABLE count). */
  readonly inQ1b: boolean;
}

export interface PlannedService {
  readonly invoice: LegacyInvoiceRow;
  readonly decision: ServiceCandidateDecision;
}

export interface PanelInventorySummary {
  readonly panelId: string;
  readonly complete: boolean;
  readonly accounts: number | null;
  readonly reason: string | null;
  readonly states: Readonly<Record<string, number>>;
  /** How the read came out, as counts (attempts, each walk's pages and totals). */
  readonly diagnostics: LegacyInventoryDiagnostics | null;
  /**
   * Present when the panel was not one complete snapshot and its needed names were decided
   * one by one (`complete` is then true for the names covered). Counts only.
   */
  readonly resolution: LegacyInventoryResolution | null;
}

export interface LegacyPlan {
  readonly users: readonly PlannedUser[];
  readonly shapes: readonly PlannedShape[];
  readonly services: readonly PlannedService[];
  readonly inventories: readonly PanelInventorySummary[];
  readonly tallies: PlanTallies;
  /**
   * Mirza `.nxpkg`: live invoices whose category the ownership hold changed (0 without a hold).
   * Already reflected in `tallies.services.categories`; reported as
   * `sections.ownershipHold.changedCategory`.
   */
  readonly ownershipHoldChanged: number;
  /**
   * Mirza `.nxpkg` inventory hold — the live invoices quarantined as `INVENTORY_INCOMPLETE`
   * because a needed username was left UNRESOLVED by a per-name read that itself SUCCEEDED
   * (`InventoryHold`). Bound into `planTalliesDigest`.
   */
  readonly inventoryHold: InventoryHold;
}

/**
 * Mirza `.nxpkg` inventory hold (`docs/legacy-migration/service-review.md` §Inventory hold).
 *
 * A live panel that keeps selling while it is read is decided one needed name at a time; a
 * name no gap-free walk decided is UNRESOLVED and its invoice `INVENTORY_INCOMPLETE`. That is
 * an uncertain SERVICE, not an uncertain import: the invoice is quarantined — history and an
 * OPEN review candidate, never adopted — and every customer, wallet and debt still imports.
 *
 * - `keys`: the held invoice keys. A dry run (no hold given) holds exactly the invoices it
 *   found unresolved that way; an apply is given the APPROVED dry run's keys back.
 * - `given`: whether `keys` was given (apply, resume, reconcile, report) or computed (dry run).
 * - `unheld`: invoices this read left unresolved that `keys` does not hold. Always 0 for a dry
 *   run; at an apply it is a plan the owner did not approve (`DRY_RUN_MISMATCH`).
 *
 * Only a read that held can quarantine: while ANY production panel's read failed (transport,
 * auth, COUNT_MISMATCH, NOT_INDEXABLE, …) nothing is held, and that failure blocks as before.
 */
export interface InventoryHold {
  readonly keys: ReadonlySet<string>;
  readonly given: boolean;
  readonly unheld: number;
  /** `inventoryHoldDigest(keys)`. */
  readonly digest: string;
}

/** SHA-256 of the sorted held invoice keys: what the report, the run inputs and the digest bind. */
export function inventoryHoldDigest(keys: ReadonlySet<string> | readonly string[]): string {
  const sorted = [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(JSON.stringify({ format: 'nexa-legacy-inventory-hold/v1', hold: sorted }));
}

/** The `reason` a panel summary carries when its per-name resolution left names unresolved. */
export const INVENTORY_NAMES_UNRESOLVED = 'UNRESOLVED';

/**
 * Whether a production panel's READ failed — as opposed to a read that held and left some
 * needed names unresolved (`complete: false`, reason `UNRESOLVED`, with its resolution), whose
 * invoices the inventory hold quarantines. A failed read blocks a production-like import.
 */
export function inventoryReadFailed(
  panel: Pick<PanelInventorySummary, 'complete' | 'reason' | 'resolution'>,
): boolean {
  // A per-name read counts as having HELD only when it found a gap-free decision walk. One that
  // never did decided nothing on that panel: a whole-panel failure in substance (review H P1),
  // which blocks exactly as a read error does — never a quarantine of the whole panel.
  return !(
    panel.complete ||
    (panel.reason === INVENTORY_NAMES_UNRESOLVED &&
      panel.resolution !== null &&
      panel.resolution.gapFree === true)
  );
}

export interface PlanTallies {
  readonly customers: {
    readonly source: number;
    readonly invalidIdentity: number;
    readonly manualReview: Readonly<
      Record<
        'BALANCE_UNREADABLE' | 'BALANCE_OUT_OF_RANGE' | 'DUPLICATE_SOURCE_ID' | 'STATUS_UNKNOWN',
        number
      >
    >;
    /** `User_Status` of every source row, classified (OQ-LWD-07). Σ = `source`. */
    readonly legacyStatus: Readonly<Record<LegacyUserStatusClass, number>>;
    /**
     * Importable users blocked in MirzaBot: `new` are created BLOCKED; `existing` are NEXA
     * customers the import never changes, so their NEXA status stands (owner decision).
     */
    readonly blocked: { readonly new: number; readonly existing: number };
    /** Source ids on more than one row: how many ids, and how many rows carry them. */
    readonly duplicateSourceIds: { readonly ids: number; readonly rows: number };
    readonly importable: number;
    readonly existing: number;
    readonly new: number;
    readonly agents: number;
    readonly phone: Readonly<Record<'ABSENT' | 'VALID' | 'INVALID', number>>;
  };
  readonly wallet: {
    readonly currency: string;
    readonly legacySumMinor: bigint;
    readonly positive: { readonly count: number; readonly sumMinor: bigint };
    readonly zero: number;
    readonly negative: { readonly count: number; readonly sumMinor: bigint };
    readonly openings: Readonly<Record<OpeningPlan, number>>;
    /** The part of `openings` for NEGATIVE balances (a DEBIT opening each). */
    readonly debitOpenings: Readonly<Record<OpeningPlan, number>>;
  };
  readonly trials: Readonly<Record<TrialPlan, number>>;
  readonly products: {
    readonly hiddenShapeInvoices: number;
    readonly distinctShapes: number;
    readonly q1bDistinctMappable: number;
    readonly existingShapes: number;
    readonly newShapes: number;
    readonly unmappable: Readonly<Partial<Record<LegacyShapeUnmappableReason, number>>>;
    readonly predictedTariff: Readonly<
      Record<'MATCHED' | 'NO_CURRENT_TARIFF' | 'AMBIGUOUS_TARIFF', number>
    >;
    readonly namedProductCandidates: number;
  };
  readonly services: {
    readonly candidates: number;
    readonly categories: Readonly<Record<ServiceCandidateCategory, number>>;
    readonly unmappedCodePanels: Readonly<Record<string, number>>;
  };
}

export interface PlanInput {
  readonly snapshot: LegacySnapshot;
  readonly mapping: PanelMapping;
  readonly salesCurrency: string;
  readonly existingCustomers: ReadonlyMap<string, string>;
  readonly existingOpenings: ReadonlyMap<string, bigint>;
  readonly trialOverrides: ReadonlyMap<string, number>;
  readonly trialDecided: ReadonlySet<string>;
  readonly existingShapes: ReadonlyMap<
    string,
    { readonly id: string; readonly tariffStatus: string }
  >;
  readonly tariffCandidates: readonly TariffCandidate[];
  readonly inventories: ReadonlyMap<string, LegacyInventoryRead>;
  /** Mirza PR5: the operator's review, as the run accepted it (`ServiceReviewInputs`). */
  readonly review?: ServiceReviewInputs;
}

const TRIAL_PLANS: readonly TrialPlan[] = [
  'KEPT_EXISTING_OVERRIDE',
  'LEGACY_LIMIT_UNREADABLE',
  'LEGACY_NO_TRIALS',
  'LEGACY_TRIAL_CONSUMED',
  'INHERIT_NEXA_POLICY',
  'ALREADY_DECIDED',
];

function zeroes<K extends string>(keys: readonly K[]): Record<K, number> {
  return Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
}

/**
 * `existing` is the SIGNED ledger opening already posted. A figure that differs from it — in
 * amount or in sign — is a CONFLICT, never re-applied: exactly the opening service's own rule.
 */
export function openingPlanFor(balanceMinor: bigint, existing: bigint | undefined): OpeningPlan {
  if (existing === undefined) return balanceMinor === 0n ? 'ZERO_NO_ENTRY' : 'POST';
  return existing === balanceMinor ? 'ALREADY_POSTED' : 'CONFLICT';
}

/**
 * The source user ids the plan imports (its `importedUsers` keys): not a duplicated id, and a
 * customer decision that is neither INVALID_IDENTITY nor MANUAL_REVIEW. The same rule as
 * `planLegacyImport`, which a test pins it to; what the per-name inventory resolution asks of
 * a panel is limited to these owners' invoices, the only ones the matcher consults it for.
 */
export function importableLegacyUserIds(
  users: LegacySnapshot['users'],
  existingCustomers: ReadonlyMap<string, string>,
): Set<string> {
  const duplicates = duplicateSourceIds(users);
  const out = new Set<string>();
  for (const row of users) {
    if (duplicates.has(row.id)) continue;
    const decision = decideLegacyUser(row, existingCustomers.has(row.id));
    if (decision.kind === 'INVALID_IDENTITY' || decision.kind === 'MANUAL_REVIEW') continue;
    out.add(row.id);
  }
  return out;
}

/**
 * Mirza PR4 — the source ids that occur on more than one row. Only ids that ARE Telegram
 * ids are counted (any other id is INVALID_IDENTITY whatever its multiplicity), and the
 * comparison is exact: a Telegram id has one spelling.
 */
export function duplicateSourceIds(
  users: readonly { readonly id: string; readonly checksum: string }[],
): ReadonlyMap<string, string> {
  const rows = new Map<string, string[]>();
  for (const u of users) {
    if (legacyTelegramId(u.id) === null) continue;
    const list = rows.get(u.id);
    if (list === undefined) rows.set(u.id, [u.checksum]);
    else list.push(u.checksum);
  }
  // id → one checksum standing for every row of it: order-free, so the review row it keys
  // is the same whichever order the source returned them in.
  const out = new Map<string, string>();
  for (const [id, checksums] of rows) {
    if (checksums.length < 2) continue;
    out.set(id, sha256Hex(`user-duplicate:v1\n${[...checksums].sort().join('\n')}`));
  }
  return out;
}

/**
 * Every live invoice's category. Shared by the plan and by the import's services phase,
 * which calls it again AFTER the products phase with the tariffs as they now are and the
 * users the customers phase actually imported.
 */
/**
 * Mirza PR5 — what the operator's review says about candidates, as the plan may use it.
 *
 * - `operatorPanels`: invoice key → the panel an explicit ADOPT approval names, ONLY for
 *   approvals the run accepted (`approvalGate`: not synthetic on a production-like target,
 *   bound to this very source row, the panel mapped explicitly). Matched on that panel with
 *   every other rule unchanged.
 * - `keptAsHistory`: invoice keys a person kept as history. They are still decided (and
 *   reported), but they are no claim on an account: the ownership rule ignores them.
 */
export interface ServiceReviewInputs {
  readonly operatorPanels?: ReadonlyMap<string, string>;
  readonly keptAsHistory?: ReadonlySet<string>;
  /**
   * Mirza `.nxpkg` importer (`nxpkg-ownership.ts`): invoice keys the package's ownership
   * evidence holds back — quarantined, rejected, pending or stale decisions, unproven
   * ownership. An invoice NEXA would adopt is decided `AMBIGUOUS_OWNERSHIP` instead (manual
   * review, never adopted). It is still a claim on its account for the ownership rule, so a
   * second owner's invoice naming the same account stays ambiguous too. It can only remove
   * an invoice from adoption, never add one.
   */
  readonly ownershipHold?: ReadonlySet<string>;
  /**
   * Mirza `.nxpkg` inventory hold (`InventoryHold`): the APPROVED dry run's held invoice keys,
   * given back to an apply (and its resume, reconcile and report). It only DEMOTES: a held
   * invoice whose category the inventory decides is `INVENTORY_INCOMPLETE` whatever this read
   * says, so a name the apply now resolves is still not adopted — nothing is adopted that the
   * owner did not approve, and the plan's digest stays the approved one. Absent for a dry run.
   */
  readonly inventoryHold?: ReadonlySet<string>;
}

export function decideAllServices(
  snapshot: LegacySnapshot,
  mapping: PanelMapping,
  indexes: ReadonlyMap<string, PanelInventoryIndex>,
  importedUsers: ReadonlyMap<string, string>,
  tariffOf: (shapeKey: string) => 'RESOLVED' | 'UNRESOLVED',
  review: ServiceReviewInputs = {},
): {
  readonly services: readonly PlannedService[];
  readonly categories: Readonly<Record<ServiceCandidateCategory, number>>;
  readonly namedProductCandidates: number;
  /** Live invoices whose category the ownership hold changed (ADOPTION_ELIGIBLE → AMBIGUOUS_OWNERSHIP). */
  readonly ownershipHoldChanged: number;
  /** Live invoices THIS read left `INVENTORY_INCOMPLETE` (before any inventory hold). */
  readonly undecidable: ReadonlySet<string>;
} {
  const userIds = new Set(snapshot.users.map((u) => u.id));
  const categories = zeroes<ServiceCandidateCategory>(SERVICE_CANDIDATE_CATEGORIES);
  const decided: PlannedService[] = [];
  const undecidable = new Set<string>();
  const inventoryHold = review.inventoryHold ?? new Set<string>();
  for (const invoice of snapshot.liveInvoices) {
    const panelId = review.operatorPanels?.get(invoice.idInvoice);
    const fresh = decideServiceCandidate(
      invoice,
      {
        userIds,
        importedUsers,
        policy: mapping.policy,
        inventories: indexes,
        productCodes: snapshot.productCodes,
        productMap: mapping.products,
        tariffOf,
      },
      panelId === undefined ? null : { panelId },
    );
    if (fresh.category === 'INVENTORY_INCOMPLETE') undecidable.add(invoice.idInvoice);
    // The inventory hold first, before the ownership rule: a held invoice is no claim on an
    // account, exactly as it was none when the approved dry run found it unresolved.
    const decision =
      inventoryHold.has(invoice.idInvoice) && INVENTORY_DERIVED_CATEGORIES.has(fresh.category)
        ? inventoryHeldDecision()
        : fresh;
    decided.push({ invoice, decision });
  }
  const ruled = withOwnershipRule(decided, review.keptAsHistory ?? new Set());
  const services = withOwnershipHold(ruled, review.ownershipHold ?? new Set());
  const ownershipHoldChanged = services.filter(
    (s, i) => s.decision.category !== ruled[i]?.decision.category,
  ).length;
  let namedProductCandidates = 0;
  for (const { decision } of services) {
    categories[decision.category] += 1;
    if (decision.category === 'ADOPTION_ELIGIBLE' && decision.product.kind === 'NAMED_PRODUCT') {
      namedProductCandidates += 1;
    }
  }
  return { services, categories, namedProductCandidates, ownershipHoldChanged, undecidable };
}

/**
 * Mirza PR5 — the customer must be identified with confidence. When live invoices of two or
 * more DIFFERENT legacy owners would adopt the same account (the same panel and lowercase
 * name), every one of them is `AMBIGUOUS_OWNERSHIP`: which customer holds the account is a
 * guess, and the first in key order is not an answer. An invoice a person kept as history is
 * no claim. Invoices of ONE owner naming one account keep the P6 rule (the first adopts; the
 * rest find the name taken, which P6 reports as a conflicting existing entity).
 */
export function withOwnershipRule(
  services: readonly PlannedService[],
  keptAsHistory: ReadonlySet<string>,
): readonly PlannedService[] {
  const owners = new Map<string, Set<string>>();
  const accountOf = (s: PlannedService): string | null =>
    s.decision.category === 'ADOPTION_ELIGIBLE' && !keptAsHistory.has(s.invoice.idInvoice)
      ? JSON.stringify([s.decision.panelId, s.decision.providerUsername.toLowerCase()])
      : null;
  for (const s of services) {
    const account = accountOf(s);
    if (account === null || s.decision.category !== 'ADOPTION_ELIGIBLE') continue;
    const set = owners.get(account) ?? new Set<string>();
    set.add(s.decision.telegramUserId);
    owners.set(account, set);
  }
  return services.map((s) => {
    const account = accountOf(s);
    if (account === null || (owners.get(account)?.size ?? 0) < 2) return s;
    return {
      invoice: s.invoice,
      decision: { category: 'AMBIGUOUS_OWNERSHIP', map: INVOICE_MAP_DECISIONS.AMBIGUOUS_OWNERSHIP },
    };
  });
}

/**
 * Mirza `.nxpkg` importer — an eligible invoice the package's ownership evidence holds back is
 * `AMBIGUOUS_OWNERSHIP`: the same category, map decision and review row as an ownership NEXA
 * itself cannot decide. Every other category is left as it is.
 */
export function withOwnershipHold(
  services: readonly PlannedService[],
  hold: ReadonlySet<string>,
): readonly PlannedService[] {
  if (hold.size === 0) return services;
  return services.map((s) =>
    s.decision.category === 'ADOPTION_ELIGIBLE' && hold.has(s.invoice.idInvoice)
      ? {
          invoice: s.invoice,
          decision: {
            category: 'AMBIGUOUS_OWNERSHIP',
            map: INVOICE_MAP_DECISIONS.AMBIGUOUS_OWNERSHIP,
          },
        }
      : s,
  );
}

/** The complete indexes of the production panels whose inventory read is complete. */
export function inventoryIndexes(
  mapping: PanelMapping,
  inventories: ReadonlyMap<string, LegacyInventoryRead>,
): ReadonlyMap<string, PanelInventoryIndex> {
  const out = new Map<string, PanelInventoryIndex>();
  for (const panelId of mapping.policy.productionPanelIds) {
    const read = inventories.get(panelId);
    if (read !== undefined && read.ok && read.complete) out.set(panelId, read.index);
  }
  return out;
}

export function planLegacyImport(input: PlanInput): LegacyPlan {
  const { snapshot } = input;

  // --- customers, openings, trials --------------------------------------------------------
  const customers = {
    source: snapshot.users.length,
    invalidIdentity: 0,
    manualReview: {
      BALANCE_UNREADABLE: 0,
      BALANCE_OUT_OF_RANGE: 0,
      DUPLICATE_SOURCE_ID: 0,
      STATUS_UNKNOWN: 0,
    },
    legacyStatus: zeroes<LegacyUserStatusClass>(LEGACY_USER_STATUS_CLASSES),
    blocked: { new: 0, existing: 0 },
    duplicateSourceIds: { ids: 0, rows: 0 },
    importable: 0,
    existing: 0,
    new: 0,
    agents: 0,
    phone: { ABSENT: 0, VALID: 0, INVALID: 0 },
  };
  const wallet = {
    currency: input.salesCurrency,
    legacySumMinor: 0n,
    positive: { count: 0, sumMinor: 0n },
    zero: 0,
    negative: { count: 0, sumMinor: 0n },
    openings: zeroes<OpeningPlan>(OPENING_PLANS),
    debitOpenings: zeroes<OpeningPlan>(OPENING_PLANS),
  };
  const trials = zeroes<TrialPlan>(TRIAL_PLANS);
  const importedUsers = new Map<string, string>();
  const users: PlannedUser[] = [];

  const duplicates = duplicateSourceIds(snapshot.users);
  customers.duplicateSourceIds.ids = duplicates.size;
  for (const row0 of snapshot.users) {
    const duplicateChecksum = duplicates.get(row0.id);
    // Every row of a duplicated id carries the same order-free checksum, so the ONE review
    // row they key is written once and found unchanged by the others.
    const row = duplicateChecksum === undefined ? row0 : { ...row0, checksum: duplicateChecksum };
    customers.phone[row.phone] += 1;
    customers.legacyStatus[row.status] += 1;
    if (legacyIsAgent(row.agent)) customers.agents += 1;
    const existingCustomerId = input.existingCustomers.get(row.id) ?? null;
    const decision: LegacyUserDecision =
      duplicateChecksum === undefined
        ? decideLegacyUser(row, existingCustomerId !== null)
        : { kind: 'MANUAL_REVIEW', reason: 'DUPLICATE_SOURCE_ID', mapReason: 'INVALID_SOURCE_ROW' };
    if (duplicateChecksum !== undefined) customers.duplicateSourceIds.rows += 1;
    if (decision.kind === 'INVALID_IDENTITY') {
      customers.invalidIdentity += 1;
      users.push({ row, decision, existingCustomerId: null, opening: null, trial: null });
      continue;
    }
    if (decision.kind === 'MANUAL_REVIEW') {
      customers.manualReview[decision.reason] += 1;
      users.push({ row, decision, existingCustomerId, opening: null, trial: null });
      continue;
    }
    customers.importable += 1;
    if (decision.customer === 'EXISTING') customers.existing += 1;
    else customers.new += 1;
    if (decision.blocked) {
      if (decision.customer === 'EXISTING') customers.blocked.existing += 1;
      else customers.blocked.new += 1;
    }
    importedUsers.set(row.id, decision.telegramUserId);

    wallet.legacySumMinor += decision.balanceMinor;
    if (decision.openingKind === 'POSITIVE') {
      wallet.positive.count += 1;
      wallet.positive.sumMinor += decision.balanceMinor;
    } else if (decision.openingKind === 'NEGATIVE') {
      wallet.negative.count += 1;
      wallet.negative.sumMinor += decision.balanceMinor;
    } else {
      wallet.zero += 1;
    }
    const opening = openingPlanFor(
      decision.balanceMinor,
      input.existingOpenings.get(decision.telegramUserId),
    );
    wallet.openings[opening] += 1;
    if (decision.balanceMinor < 0n) wallet.debitOpenings[opening] += 1;

    let trial: TrialPlan;
    if (existingCustomerId !== null && input.trialDecided.has(existingCustomerId)) {
      trial = 'ALREADY_DECIDED';
    } else {
      const override =
        existingCustomerId === null ? null : (input.trialOverrides.get(existingCustomerId) ?? null);
      trial = decideLegacyTrial(
        { limitUsertest: row.limitUsertest, hadTrial: snapshot.trialUsers.has(row.id) },
        override,
      ).decision;
    }
    trials[trial] += 1;
    users.push({ row, decision, existingCustomerId, opening, trial });
  }

  // --- hidden legacy product shapes -------------------------------------------------------
  const shapeMap = new Map<string, PlannedShape>();
  const unmappable: Partial<Record<LegacyShapeUnmappableReason, number>> = {};
  const q1bKeys = new Set<string>();
  let hiddenShapeInvoices = 0;
  for (const invoice of snapshot.liveInvoices) {
    if (!needsHiddenShape(invoice, snapshot.productCodes)) continue;
    hiddenShapeInvoices += 1;
    const shapeInput: LegacyShapeInput = {
      codePanel: invoice.codePanel,
      volume: invoice.volume,
      serviceTime: invoice.serviceTime,
      timeUnit: invoice.timeUnit,
      isCustom: invoice.isCustom,
    };
    const keyed = legacyShapeKey(shapeInput);
    if (!keyed.ok) {
      unmappable[keyed.reason] = (unmappable[keyed.reason] ?? 0) + 1;
      continue;
    }
    if (isQ1bPopulation(invoice)) q1bKeys.add(keyed.key);
    if (shapeMap.has(keyed.key)) continue;
    const predicted = resolveCurrentTariff(
      keyed.shape,
      input.tariffCandidates,
      input.salesCurrency,
    );
    shapeMap.set(keyed.key, {
      key: keyed.key,
      input: shapeInput,
      custom: keyed.shape.isCustom,
      existing: input.existingShapes.get(keyed.key) ?? null,
      predictedTariff: predicted.kind,
      inQ1b: false,
    });
  }
  const shapes = [...shapeMap.values()]
    .map((s) => ({ ...s, inQ1b: q1bKeys.has(s.key) }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const predictedTariff = { MATCHED: 0, NO_CURRENT_TARIFF: 0, AMBIGUOUS_TARIFF: 0 };
  for (const s of shapes) predictedTariff[s.predictedTariff] += 1;
  const tariffOf = (key: string) => {
    const shape = shapeMap.get(key);
    if (shape === undefined) return 'UNRESOLVED' as const;
    return shape.existing?.tariffStatus === 'RESOLVED' || shape.predictedTariff === 'MATCHED'
      ? ('RESOLVED' as const)
      : ('UNRESOLVED' as const);
  };

  // --- service candidates -----------------------------------------------------------------
  const indexes = new Map<string, PanelInventoryIndex>();
  const inventories: PanelInventorySummary[] = [];
  for (const panelId of input.mapping.policy.productionPanelIds) {
    const read = input.inventories.get(panelId);
    if (read !== undefined && read.ok && read.complete && (read.resolution?.unresolved ?? 0) > 0) {
      // A per-name resolution that left needed names unresolved: its index still decides the
      // names it covers (the rest stay UNDECIDABLE), but the panel is NOT reported complete —
      // every consumer of `complete` (the TARGET precheck, the import's own gate, the final
      // report, reconcile, the dry run's warnings) reads it as "not fully read".
      indexes.set(panelId, read.index);
      inventories.push({
        panelId,
        complete: false,
        accounts: null,
        reason: 'UNRESOLVED',
        states: {},
        diagnostics: read.diagnostics ?? null,
        resolution: read.resolution ?? null,
      });
    } else if (read !== undefined && read.ok && read.complete) {
      indexes.set(panelId, read.index);
      // A per-name resolution's walks were not one snapshot: what they saw is not the panel's
      // count or its states, so neither is reported as if it were.
      const perName = read.resolution !== undefined;
      inventories.push({
        panelId,
        complete: true,
        accounts: perName ? null : read.accounts,
        reason: null,
        states: perName ? {} : read.states,
        diagnostics: read.diagnostics ?? null,
        resolution: read.resolution ?? null,
      });
    } else {
      inventories.push({
        panelId,
        complete: false,
        accounts: null,
        reason: read === undefined ? 'NOT_READ' : read.ok ? read.reason : read.failure,
        states: {},
        diagnostics: read?.diagnostics ?? null,
        resolution: null,
      });
    }
  }
  const { services, categories, namedProductCandidates, ownershipHoldChanged, undecidable } =
    decideAllServices(snapshot, input.mapping, indexes, importedUsers, tariffOf, input.review);
  // The inventory hold: only a read that held can quarantine. With ANY production panel's read
  // failed, nothing is held (that failure blocks); otherwise an undecidable invoice is one whose
  // needed name a successful per-name read left unresolved — unless an operator's approval
  // names a panel that has no index at all, which no read decided.
  // A panel with no index, or a per-name read that found no gap-free decision walk (review H
  // P1), is a read failure: it blocks, and nothing is held anywhere.
  const readFailures = inventories.filter(inventoryReadFailed).length;
  const unresolved = new Set(
    readFailures > 0
      ? []
      : [...undecidable].filter((key) => {
          const operatorPanel = input.review?.operatorPanels?.get(key);
          return operatorPanel === undefined || indexes.has(operatorPanel);
        }),
  );
  const given = input.review?.inventoryHold;
  const holdKeys: ReadonlySet<string> = given ?? unresolved;
  const inventoryHold: InventoryHold = {
    keys: holdKeys,
    given: given !== undefined,
    unheld: [...unresolved].filter((key) => !holdKeys.has(key)).length,
    digest: inventoryHoldDigest(holdKeys),
  };
  const realLive = snapshot.liveInvoices.filter((i) => i.isTest?.trim() === '0');

  return {
    users,
    shapes,
    services,
    inventories,
    ownershipHoldChanged,
    inventoryHold,
    tallies: {
      customers,
      wallet,
      trials,
      products: {
        hiddenShapeInvoices,
        distinctShapes: shapes.length,
        q1bDistinctMappable: q1bKeys.size,
        existingShapes: shapes.filter((s) => s.existing !== null).length,
        newShapes: shapes.filter((s) => s.existing === null).length,
        unmappable,
        predictedTariff,
        namedProductCandidates,
      },
      services: {
        candidates: snapshot.liveInvoices.length,
        categories,
        unmappedCodePanels: Object.fromEntries(
          unmappedCodePanels(
            realLive.map((i) => i.codePanel),
            input.mapping,
          ),
        ),
      },
    },
  };
}

/**
 * Mirza `.nxpkg` importer — the digest of a plan (`DRY_RUN_MISMATCH`). A dry run reports it
 * (`sections.planTalliesDigest`); an import given the approved one recomputes it at its start
 * and refuses to start on any other value. Keys sorted at every depth, a bigint as its decimal
 * string with an `n` suffix, so the value is stable across runs and processes.
 *
 * v2 binds, beside the tallies, every live invoice's service decision (`servicesDecisionDigest`).
 * The tallies alone could hold still while the plan moved: an account deleted on the panel and
 * another created between the dry run and the import turn one invoice PROVIDER_MISSING and
 * another ADOPTION_ELIGIBLE — the same counts, and an adoption of an account the owner never
 * saw in the approved plan. Runtime facts (usage, state, link) are deliberately NOT in it:
 * they move by the minute on a live panel, and the import adopts from its own read anyway.
 */
export function planTalliesDigest(
  plan: Pick<LegacyPlan, 'tallies' | 'services'> & {
    readonly inventoryHold?: Pick<InventoryHold, 'keys' | 'digest'>;
  },
): string {
  // The inventory hold is bound beside the decisions: WHICH `INVENTORY_INCOMPLETE` invoices are
  // quarantined is part of what the owner approved. An empty (or absent) hold adds nothing, so
  // the digest of every plan without one is the v2 digest it always was.
  const hold = plan.inventoryHold;
  return sha256Hex(
    stableJson({
      format: 'nexa-legacy-plan-tallies/v2',
      tallies: plan.tallies,
      services: servicesDecisionDigest(plan.services),
      inventoryHold: hold === undefined || hold.keys.size === 0 ? undefined : hold.digest,
    }),
  );
}

/**
 * The v1 digest (tallies only), the one a dry run approved before v0.5.7 carries. Asked only to
 * say WHY such an approval no longer matches (`PLAN_DIGEST_FORMAT_OUTDATED`) — never accepted.
 */
export function planTalliesDigestV1(plan: Pick<LegacyPlan, 'tallies'>): string {
  return sha256Hex(stableJson({ format: 'nexa-legacy-plan-tallies/v1', tallies: plan.tallies }));
}

/** The refusal count of an approval whose digest is the v1 digest of this very plan. */
export const PLAN_DIGEST_FORMAT_OUTDATED = 'plan:digest_format_outdated';

/**
 * The digest of every live invoice's service decision: its category and, for an eligible one,
 * the panel, the exact provider spelling, the product path and the customer it would adopt
 * into. Sorted by invoice, so it does not depend on the snapshot's row order. A digest: no
 * name or id leaves the importer through it.
 */
export function servicesDecisionDigest(services: readonly PlannedService[]): string {
  const rows = services
    .map(({ invoice, decision }) =>
      decision.category === 'ADOPTION_ELIGIBLE'
        ? [
            invoice.idInvoice,
            decision.category,
            decision.panelId,
            decision.providerUsername,
            decision.product.kind,
            decision.product.kind === 'NAMED_PRODUCT'
              ? decision.product.productId
              : decision.product.shapeKey,
            decision.telegramUserId,
          ]
        : [invoice.idInvoice, decision.category],
    )
    .map(stableJson)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sha256Hex(`[${rows.join(',')}]`);
}

/**
 * What a `DRY_RUN_MISMATCH` refusal carries, so the operator can see WHICH tally moved: the
 * import's own service categories, new customers, openings and debts, product shapes, and how
 * many production panels had no complete RickPanel inventory — the one input the dry run and
 * the import each read LIVE, which none of the seven cutover values binds. Each key names a
 * number the approved dry run's report also carries (the adapter's `mismatchCounts`), so the two
 * sides can be set beside each other. Counts only: no key, no person, no panel id.
 */
export function planTalliesRefusalCounts(
  plan: Pick<LegacyPlan, 'tallies' | 'inventories'> & {
    readonly inventoryHold?: Pick<InventoryHold, 'keys' | 'unheld'>;
  },
): Record<string, number> {
  const { tallies } = plan;
  const counts: Record<string, number> = {
    'apply:customers:importable': tallies.customers.importable,
    'apply:customers:new': tallies.customers.new,
    'apply:wallet:positive': tallies.wallet.positive.count,
    'apply:wallet:negative': tallies.wallet.negative.count,
    'apply:products:distinct_shapes': tallies.products.distinctShapes,
    // A read that FAILED — never a per-name read that held and left names to the hold.
    'apply:panels:inventory_incomplete': plan.inventories.filter(inventoryReadFailed).length,
  };
  if (plan.inventoryHold !== undefined) {
    counts['apply:inventory_hold:invoices'] = plan.inventoryHold.keys.size;
    counts['apply:inventory_hold:unheld'] = plan.inventoryHold.unheld;
  }
  for (const [category, count] of Object.entries(tallies.services.categories)) {
    counts[`apply:services:${category}`] = count;
  }
  return counts;
}

function stableJson(value: unknown): string {
  if (typeof value === 'bigint') return JSON.stringify(`${value.toString()}n`);
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('a plan tally is not a finite number');
    }
    if (value === undefined) return 'null';
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
}
