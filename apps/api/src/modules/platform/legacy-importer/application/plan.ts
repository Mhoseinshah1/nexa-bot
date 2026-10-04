import type { LegacyTrialDecision } from '@nexa/contracts';
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
  SERVICE_CANDIDATE_CATEGORIES,
  decideLegacyUser,
  decideServiceCandidate,
  isQ1bPopulation,
  legacyIsAgent,
  needsHiddenShape,
  type LegacyUserDecision,
  type ServiceCandidateCategory,
  type ServiceCandidateDecision,
} from './decisions.js';
import { unmappedCodePanels, type PanelMapping } from './panel-mapping.js';
import type { LegacyInventoryRead } from './ports.js';
import type { LegacyInvoiceRow, LegacySnapshot, LegacyUserRow } from './source-snapshot.js';

/**
 * Migration P7 — the complete decision plan for one snapshot, PURE
 * (`docs/legacy-migration/importer.md` §Plan).
 *
 * `dry-run` is this plan, counted. `import` is this plan, applied phase by phase, each
 * phase through the existing service that owns its write. There is one function that
 * decides, so a dry run and the import it previews cannot disagree about a row.
 */

export type OpeningPlan = 'POST' | 'ALREADY_POSTED' | 'ZERO_NO_ENTRY' | 'CONFLICT';
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
    readonly manualReview: Readonly<Record<'BALANCE_UNREADABLE' | 'BALANCE_OUT_OF_RANGE', number>>;
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
  readonly trialOverrides: ReadonlyMap<string, number>;
  readonly trialDecided: ReadonlySet<string>;
  readonly existingShapes: ReadonlyMap<
    string,
    { readonly id: string; readonly tariffStatus: string }
  >;
  readonly tariffCandidates: readonly TariffCandidate[];
  readonly inventories: ReadonlyMap<string, LegacyInventoryRead>;
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

export function openingPlanFor(balanceMinor: bigint, existing: bigint | undefined): OpeningPlan {
  if (existing === undefined) return balanceMinor === 0n ? 'ZERO_NO_ENTRY' : 'POST';
  return existing === balanceMinor ? 'ALREADY_POSTED' : 'CONFLICT';
}

/**
 * Every live invoice's category. Shared by the plan and by the import's services phase,
 * which calls it again AFTER the products phase with the tariffs as they now are and the
 * users the customers phase actually imported.
 */
export function decideAllServices(
  snapshot: LegacySnapshot,
  mapping: PanelMapping,
  indexes: ReadonlyMap<string, PanelInventoryIndex>,
  importedUsers: ReadonlyMap<string, string>,
  tariffOf: (shapeKey: string) => 'RESOLVED' | 'UNRESOLVED',
): {
  readonly services: readonly PlannedService[];
  readonly categories: Readonly<Record<ServiceCandidateCategory, number>>;
  readonly namedProductCandidates: number;
} {
  const userIds = new Set(snapshot.users.map((u) => u.id));
  const categories = zeroes<ServiceCandidateCategory>(SERVICE_CANDIDATE_CATEGORIES);
  const services: PlannedService[] = [];
  let namedProductCandidates = 0;
  for (const invoice of snapshot.liveInvoices) {
    const decision = decideServiceCandidate(invoice, {
      userIds,
      importedUsers,
      policy: mapping.policy,
      inventories: indexes,
      productCodes: snapshot.productCodes,
      productMap: mapping.products,
      tariffOf,
    });
    categories[decision.category] += 1;
    if (decision.category === 'ADOPTION_ELIGIBLE' && decision.product.kind === 'NAMED_PRODUCT') {
      namedProductCandidates += 1;
    }
    services.push({ invoice, decision });
  }
  return { services, categories, namedProductCandidates };
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
    manualReview: { BALANCE_UNREADABLE: 0, BALANCE_OUT_OF_RANGE: 0 },
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
    openings: zeroes<OpeningPlan>(['POST', 'ALREADY_POSTED', 'ZERO_NO_ENTRY', 'CONFLICT']),
  };
  const trials = zeroes<TrialPlan>(TRIAL_PLANS);
  const importedUsers = new Map<string, string>();
  const users: PlannedUser[] = [];

  for (const row of snapshot.users) {
    customers.phone[row.phone] += 1;
    if (legacyIsAgent(row.agent)) customers.agents += 1;
    const existingCustomerId = input.existingCustomers.get(row.id) ?? null;
    const decision = decideLegacyUser(row, existingCustomerId !== null);
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
