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
  INVOICE_MAP_DECISIONS,
  SERVICE_CANDIDATE_CATEGORIES,
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
import type { LegacyInventoryRead, RecordedDebt } from './ports.js';
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
 * What the openings phase will do for an importable user. Since owner decision 6 a negative
 * balance is `RECORD_DEBT` (a legacy debt, no ledger entry), and an existing ledger DEBIT
 * opening from the code before it is `PRIOR_DEBIT_OPENING` (never rewritten, never doubled).
 */
export type OpeningPlan =
  | 'POST'
  | 'ALREADY_POSTED'
  | 'ZERO_NO_ENTRY'
  | 'CONFLICT'
  | 'RECORD_DEBT'
  | 'DEBT_ALREADY_RECORDED'
  | 'PRIOR_DEBIT_OPENING';
export const OPENING_PLANS: readonly OpeningPlan[] = [
  'POST',
  'ALREADY_POSTED',
  'ZERO_NO_ENTRY',
  'CONFLICT',
  'RECORD_DEBT',
  'DEBT_ALREADY_RECORDED',
  'PRIOR_DEBIT_OPENING',
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
}

export interface LegacyPlan {
  readonly users: readonly PlannedUser[];
  readonly shapes: readonly PlannedShape[];
  readonly services: readonly PlannedService[];
  readonly inventories: readonly PanelInventorySummary[];
  readonly tallies: PlanTallies;
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
  /** Mirza PR4: Telegram id → the legacy debt already recorded (magnitude, evidence class). */
  readonly existingDebts?: ReadonlyMap<string, RecordedDebt>;
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
 * `existing` is the SIGNED ledger opening already posted; `existingDebt` the legacy debt
 * already recorded. A figure that differs from what is recorded — in amount, in kind, or in
 * evidence class (a synthetic debt met by a real snapshot, or the reverse) — is a CONFLICT,
 * never re-applied: exactly the opening service's own "same debt" (Codex on #233).
 */
export function openingPlanFor(
  balanceMinor: bigint,
  existing: bigint | undefined,
  existingDebt?: RecordedDebt,
  synthetic = false,
): OpeningPlan {
  if (balanceMinor < 0n) {
    if (existing !== undefined)
      return existing === balanceMinor ? 'PRIOR_DEBIT_OPENING' : 'CONFLICT';
    if (existingDebt !== undefined) {
      return existingDebt.amountMinor === -balanceMinor && existingDebt.synthetic === synthetic
        ? 'DEBT_ALREADY_RECORDED'
        : 'CONFLICT';
    }
    return 'RECORD_DEBT';
  }
  if (existingDebt !== undefined) return 'CONFLICT';
  if (existing === undefined) return balanceMinor === 0n ? 'ZERO_NO_ENTRY' : 'POST';
  return existing === balanceMinor ? 'ALREADY_POSTED' : 'CONFLICT';
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
} {
  const userIds = new Set(snapshot.users.map((u) => u.id));
  const categories = zeroes<ServiceCandidateCategory>(SERVICE_CANDIDATE_CATEGORIES);
  const decided: PlannedService[] = [];
  for (const invoice of snapshot.liveInvoices) {
    const panelId = review.operatorPanels?.get(invoice.idInvoice);
    const decision = decideServiceCandidate(
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
    decided.push({ invoice, decision });
  }
  const services = withOwnershipHold(
    withOwnershipRule(decided, review.keptAsHistory ?? new Set()),
    review.ownershipHold ?? new Set(),
  );
  let namedProductCandidates = 0;
  for (const { decision } of services) {
    categories[decision.category] += 1;
    if (decision.category === 'ADOPTION_ELIGIBLE' && decision.product.kind === 'NAMED_PRODUCT') {
      namedProductCandidates += 1;
    }
  }
  return { services, categories, namedProductCandidates };
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
      input.existingDebts?.get(decision.telegramUserId),
      snapshot.synthetic,
    );
    wallet.openings[opening] += 1;

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
    if (read !== undefined && read.ok && read.complete) {
      indexes.set(panelId, read.index);
      inventories.push({
        panelId,
        complete: true,
        accounts: read.accounts,
        reason: null,
        states: read.states,
      });
    } else {
      inventories.push({
        panelId,
        complete: false,
        accounts: null,
        reason: read === undefined ? 'NOT_READ' : read.ok ? read.reason : read.failure,
        states: {},
      });
    }
  }
  const { services, categories, namedProductCandidates } = decideAllServices(
    snapshot,
    input.mapping,
    indexes,
    importedUsers,
    tariffOf,
    input.review,
  );
  const realLive = snapshot.liveInvoices.filter((i) => i.isTest?.trim() === '0');

  return {
    users,
    shapes,
    services,
    inventories,
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
