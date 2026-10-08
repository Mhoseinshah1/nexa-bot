import {
  LEGACY_SERVICE_CANDIDATE_KEY_MAX,
  LEGACY_SERVICE_OUTCOMES,
  LEGACY_SERVICE_OUTCOMES_SECTION_VERSION,
  LEGACY_SERVICE_REVIEW_STATES,
  type LegacyServiceApprovalRefusal,
  type LegacyServiceEvidence,
  type LegacyServiceOutcome,
  type LegacyServiceReviewState,
} from '@nexa/contracts';
import {
  legacyCustomFlag,
  legacyShapeKey,
} from '../../../commerce/catalog/application/legacy-shape.js';
import {
  isReviewClosedToRerun,
  type LegacyImportMapRecord,
} from '../../legacy-import/application/legacy-import-ports.js';
import { canonicalLegacyUsername } from '../../legacy-import/application/legacy-service-matching.js';
import type { LegacyServiceCandidateRecord } from '../../legacy-service-review/application/ports.js';
import { isAdoptedOutcome } from '../../legacy-service-review/domain/candidate-rules.js';
import { legacyCodePanel, type ServiceCandidateDecision } from './decisions.js';
import type { PanelMapping } from './panel-mapping.js';
import type { LegacyAdoptionOutcome, LegacyInventoryRead } from './ports.js';
import type { LegacyInvoiceRow, LegacySnapshot } from './source-snapshot.js';

/**
 * Mirza migration PR5 — every live legacy invoice's ONE outcome, the evidence behind it, the
 * gate an operator's ADOPT approval passes before a run acts on it, and the reconciliation
 * section. Pure; no I/O (`docs/legacy-migration/service-review.md`).
 */

// --- outcomes ---------------------------------------------------------------------------------

/** What the run did with an ELIGIBLE candidate. */
export type EligibleResult =
  | { readonly kind: 'ADOPTION'; readonly outcome: LegacyAdoptionOutcome }
  /** A person kept it as history: never handed to the adoption. */
  | { readonly kind: 'KEPT_AS_HISTORY' }
  /** The adoption step is not wired: reported, never adopted and never dropped. */
  | { readonly kind: 'PENDING' };

export interface CandidateOutcome {
  readonly outcome: LegacyServiceOutcome;
  /** The raw map or adoption reason behind it (a code), when there is one. */
  readonly blocker: string | null;
  /** The NEXA service, exactly for an adopted outcome. */
  readonly serviceId: string | null;
}

/** The P6 review reasons, as the candidate outcome that names the same blocker. */
const ADOPTION_REVIEW_OUTCOME: Readonly<Record<string, LegacyServiceOutcome>> = {
  PROVIDER_MISSING: 'PROVIDER_MISSING',
  AMBIGUOUS_PANEL: 'AMBIGUOUS_PANEL',
  PANEL_UNMAPPED: 'PANEL_UNMAPPED',
  USERNAME_CASE_COLLISION: 'USERNAME_CASE_COLLISION',
  INVENTORY_INCOMPLETE: 'INVENTORY_INCOMPLETE',
  INVALID_SOURCE_ROW: 'INVALID_SOURCE_ROW',
  CUSTOMER_MISSING: 'CUSTOMER_NOT_IMPORTED',
  PRODUCT_MAPPING_UNRESOLVED: 'PRODUCT_UNRESOLVED',
  SUBSCRIPTION_REF_BLOCKED: 'SUBSCRIPTION_REF_BLOCKED',
  // The name is already a NEXA service or reservation, or the customer found is another.
  CONFLICTING_EXISTING_ENTITY: 'AMBIGUOUS_OWNERSHIP',
  UNSUPPORTED_SHAPE: 'UNSUPPORTED_SHAPE',
};

/**
 * The ONE outcome of a live invoice in a run, deterministic from what the run decided and
 * what the map said BEFORE the run:
 *
 * 1. An invoice already adopted (its map row IMPORTED as a SERVICE) is `ALREADY_ADOPTED`,
 *    whatever this snapshot says — a service is never "unadopted". When this run would not
 *    adopt it now, the category is its blocker: attention for a person, never an undo.
 * 2. A map row a person closed in the terminal queue is `REVIEW_CLOSED`: no run acts on it.
 * 3. An eligible invoice is what the adoption answered (or kept as history / pending).
 * 4. Anything else is its category, with the map's reason as the blocker.
 */
export function candidateOutcome(
  decision: ServiceCandidateDecision,
  priorMap: LegacyImportMapRecord | undefined,
  eligible: EligibleResult | null,
): CandidateOutcome {
  if (
    priorMap !== undefined &&
    priorMap.status === 'IMPORTED' &&
    priorMap.entityType === 'SERVICE' &&
    priorMap.entityId !== null
  ) {
    return {
      outcome: 'ALREADY_ADOPTED',
      blocker: decision.category === 'ADOPTION_ELIGIBLE' ? null : decision.category,
      serviceId: priorMap.entityId,
    };
  }
  if (priorMap !== undefined && isReviewClosedToRerun(priorMap)) {
    return { outcome: 'REVIEW_CLOSED', blocker: priorMap.reasonCode, serviceId: null };
  }
  if (decision.category !== 'ADOPTION_ELIGIBLE') {
    return {
      outcome: decision.category,
      blocker: decision.map?.reasonCode ?? null,
      serviceId: null,
    };
  }
  if (eligible === null || eligible.kind !== 'ADOPTION') {
    return { outcome: 'ADOPTION_ELIGIBLE', blocker: null, serviceId: null };
  }
  const o = eligible.outcome;
  switch (o.kind) {
    case 'ADOPTED':
      return { outcome: 'ADOPTED', blocker: null, serviceId: o.serviceId };
    case 'ALREADY_ADOPTED':
      return { outcome: 'ALREADY_ADOPTED', blocker: null, serviceId: o.serviceId };
    case 'SKIPPED':
      return { outcome: 'TEST_PANEL_SKIPPED', blocker: o.reason, serviceId: null };
    case 'FAILED':
      return { outcome: 'PROVIDER_READ_FAILED', blocker: o.reason, serviceId: null };
    case 'REVIEW_CLOSED':
      return { outcome: 'REVIEW_CLOSED', blocker: o.reason, serviceId: null };
    case 'KEPT_AS_HISTORY':
      // A person kept it as history between the run's read and the adoption's lock.
      return { outcome: 'ADOPTION_ELIGIBLE', blocker: 'KEPT_AS_HISTORY', serviceId: null };
    case 'MANUAL_REVIEW':
      return {
        outcome: ADOPTION_REVIEW_OUTCOME[o.reason] ?? 'INVALID_SOURCE_ROW',
        blocker: o.reason,
        serviceId: null,
      };
  }
}

// --- evidence --------------------------------------------------------------------------------

export interface EvidenceContext {
  readonly mapping: PanelMapping;
  readonly inventories: ReadonlyMap<string, LegacyInventoryRead>;
  readonly userIds: ReadonlySet<string>;
  readonly importedUsers: ReadonlyMap<string, string>;
  readonly productCodes: ReadonlySet<string>;
  readonly tariffOf: (shapeKey: string) => 'RESOLVED' | 'UNRESOLVED';
  /** Lowercase legacy username → live invoices (not kept as history) that carry it. */
  readonly claimsByName: ReadonlyMap<string, number>;
}

/** The panels the map maps EXPLICITLY (`panels`): the only ones an approval may name. */
export function mappedPanelIds(mapping: PanelMapping): ReadonlySet<string> {
  return new Set(mapping.policy.knownPanels.values());
}

/** Lowercase name → how many live invoices not kept as history carry it. */
export function claimsByName(
  invoices: readonly LegacyInvoiceRow[],
  keptAsHistory: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const invoice of invoices) {
    if (keptAsHistory.has(invoice.idInvoice)) continue;
    const name = canonicalLegacyUsername(invoice.username ?? '');
    if (name === null) continue;
    out.set(name, (out.get(name) ?? 0) + 1);
  }
  return out;
}

/**
 * What a person needs to review the outcome, and nothing that identifies anyone: the class of
 * the panel code and the panel the map gives it; whether the owner was imported; every
 * production panel whose COMPLETE inventory holds the lowercase name (spellings, state when
 * unique, and whether the panel is mapped) — evidence, never a decision; the incomplete
 * panels; the product path; and how many live invoices carry the same name.
 */
export function candidateEvidence(
  invoice: LegacyInvoiceRow,
  ctx: EvidenceContext,
): LegacyServiceEvidence {
  const { policy } = ctx.mapping;
  const code = legacyCodePanel(invoice.codePanel);
  const panelCodeClass: LegacyServiceEvidence['panelCodeClass'] =
    code === null
      ? 'EMPTY'
      : policy.testPanels.has(code)
        ? 'TEST'
        : policy.knownPanels.has(code)
          ? 'MAPPED'
          : policy.missingPanels.has(code)
            ? 'DECLARED_MISSING'
            : ctx.mapping.unresolved.has(code)
              ? 'DECLARED_UNRESOLVED'
              : 'UNMAPPED';
  const mappedPanelId = code === null ? null : (policy.knownPanels.get(code) ?? null);
  const customer: LegacyServiceEvidence['customer'] =
    invoice.idUser === null || !ctx.userIds.has(invoice.idUser)
      ? 'ORPHAN'
      : ctx.importedUsers.has(invoice.idUser)
        ? 'IMPORTED'
        : 'NOT_IMPORTED';

  const mapped = mappedPanelIds(ctx.mapping);
  const name = canonicalLegacyUsername(invoice.username ?? '');
  const holders: LegacyServiceEvidence['holders'][number][] = [];
  const incompletePanels: string[] = [];
  for (const panelId of [...new Set(policy.productionPanelIds)].sort()) {
    const read = ctx.inventories.get(panelId);
    if (read === undefined || !read.ok || !read.complete) {
      incompletePanels.push(panelId);
      continue;
    }
    if (name === null) continue;
    const spellings = read.index.usernames.get(name) ?? [];
    if (spellings.length === 0) continue;
    const only = spellings.length === 1 ? spellings[0] : undefined;
    holders.push({
      panelId,
      mapped: mapped.has(panelId),
      spellings: spellings.length,
      state: only === undefined ? null : (read.runtime.get(only)?.state ?? null),
    });
  }

  let product: LegacyServiceEvidence['product'] = {
    path: 'NONE',
    productId: null,
    resolved: false,
  };
  const custom = legacyCustomFlag(invoice.isCustom);
  const codeProduct = invoice.codeProduct?.trim() ?? '';
  if (custom !== null) {
    if (codeProduct !== '' && !custom && ctx.productCodes.has(codeProduct)) {
      const productId = ctx.mapping.products.get(codeProduct) ?? null;
      product = { path: 'NAMED_PRODUCT', productId, resolved: productId !== null };
    } else {
      const keyed = legacyShapeKey({
        codePanel: invoice.codePanel,
        volume: invoice.volume,
        serviceTime: invoice.serviceTime,
        timeUnit: invoice.timeUnit,
        isCustom: invoice.isCustom,
      });
      if (keyed.ok) {
        product = {
          path: 'HIDDEN_SHAPE',
          productId: null,
          resolved: ctx.tariffOf(keyed.key) === 'RESOLVED',
        };
      }
    }
  }

  return {
    panelCodeClass,
    mappedPanelId,
    customer,
    holders,
    incompletePanels,
    product,
    claims: name === null ? 0 : (ctx.claimsByName.get(name) ?? 0),
  };
}

/** When the walk of the panel the decision rests on finished; null when it rests on none. */
export function observedAtFor(
  panelId: string | null,
  inventories: ReadonlyMap<string, LegacyInventoryRead>,
): Date | null {
  if (panelId === null) return null;
  const read = inventories.get(panelId);
  return read !== undefined && read.ok && read.complete ? read.observedAt : null;
}

// --- the approval gate ------------------------------------------------------------------------

export type ApprovalGate =
  /** Not acted on, not changed: a person investigates (audited). */
  | { readonly kind: 'LEAVE'; readonly why: 'SYNTHETIC_ON_PRODUCTION' | 'SOURCE_CLASS_MISMATCH' }
  /** The approval is not executed; the candidate goes back to OPEN with this code. */
  | { readonly kind: 'REFUSE'; readonly refusal: LegacyServiceApprovalRefusal }
  /** Decide this invoice again — on the operator's panel when one was named. */
  | { readonly kind: 'ACCEPT'; readonly panelId: string | null };

/**
 * Before a run acts on a stored approval. A STORED state is resumed without the source that
 * made it, so its synthetic flag is checked against the target first (the PR3 lesson): a
 * synthetic approval in a production-like database is never executed. Then the approval must
 * still describe THIS row (bound to its checksum), and the panel it names must be one the
 * run's panel map maps explicitly, never one the invoice's own code maps elsewhere — and
 * only for an invoice whose code is EMPTY: a non-empty code the map does not map is refused
 * `PANEL_UNMAPPED` (aud5 F2, OQ-LSR-01).
 */
export function approvalGate(
  approval: Pick<
    LegacyServiceCandidateRecord,
    'synthetic' | 'approvedChecksum' | 'approvedPanelId'
  >,
  invoice: LegacyInvoiceRow | undefined,
  context: {
    readonly mapping: PanelMapping;
    readonly productionLikeTarget: boolean;
    readonly snapshotSynthetic: boolean;
  },
): ApprovalGate {
  if (approval.synthetic && context.productionLikeTarget) {
    return { kind: 'LEAVE', why: 'SYNTHETIC_ON_PRODUCTION' };
  }
  if (approval.synthetic !== context.snapshotSynthetic) {
    return { kind: 'LEAVE', why: 'SOURCE_CLASS_MISMATCH' };
  }
  if (invoice === undefined) return { kind: 'REFUSE', refusal: 'NOT_LIVE' };
  if (invoice.checksum !== approval.approvedChecksum) {
    return { kind: 'REFUSE', refusal: 'SOURCE_CHANGED' };
  }
  const panelId = approval.approvedPanelId;
  if (panelId === null) return { kind: 'ACCEPT', panelId: null };
  if (!mappedPanelIds(context.mapping).has(panelId)) {
    return { kind: 'REFUSE', refusal: 'PANEL_NOT_MAPPED' };
  }
  const code = legacyCodePanel(invoice.codePanel);
  if (code !== null) {
    const mappedTo = context.mapping.policy.knownPanels.get(code);
    if (mappedTo !== undefined && mappedTo !== panelId) {
      return { kind: 'REFUSE', refusal: 'PANEL_CONFLICTS_WITH_MAP' };
    }
    // aud5 F2 / OQ-LSR-01: a named panel is for an EMPTY code only. A non-empty code the
    // run's map does not map (unmapped, unresolved, declared missing, test) names a real
    // panel, and is never adopted onto another one.
    if (mappedTo === undefined) return { kind: 'REFUSE', refusal: 'PANEL_UNMAPPED' };
  }
  return { kind: 'ACCEPT', panelId };
}

/** Whether a key can be held by a candidate row (the archive's bound; no NUL). */
export function recordableKey(key: string): boolean {
  return (
    key.length >= 1 &&
    [...key].length <= LEGACY_SERVICE_CANDIDATE_KEY_MAX &&
    !key.includes('\u0000')
  );
}

/** A legacy code as the candidate row holds it: trimmed, or null when empty or unholdable. */
export function recordableCode(raw: string | null): string | null {
  const code = legacyCodePanel(raw);
  if (code === null || code.includes('\u0000') || [...code].length > 1000) return null;
  return code;
}

// --- the reconciliation section ---------------------------------------------------------------

export interface ServiceOutcomesSection {
  readonly version: typeof LEGACY_SERVICE_OUTCOMES_SECTION_VERSION;
  readonly sourceFingerprint: string;
  readonly synthetic: boolean;
  /** The import run whose decisions the section reads (the tenant's latest APPLY run). */
  readonly runId: string;
  /** Live invoices in this snapshot: the service candidates. */
  readonly candidates: number;
  /** Of those, with a candidate row. */
  readonly recorded: number;
  /** Over the recorded rows; Σ = recorded. */
  readonly outcomes: Readonly<Record<LegacyServiceOutcome, number>>;
  readonly invariant: {
    readonly statement: 'every service candidate assigned exactly one deterministic outcome';
    readonly holds: boolean;
    /** Candidates with no row. */
    readonly missing: number;
    /** Candidates whose key no row can hold (a NUL, or beyond the archive's bound). */
    readonly unrecordable: number;
    /** Rows decided by another run, or from another source, or another row of the invoice. */
    readonly decidedByAnotherRun: number;
    readonly fromAnotherSource: number;
    readonly checksumDiffers: number;
  };
  /** Recorded candidates that ARE a NEXA service (ADOPTED + ALREADY_ADOPTED). */
  readonly adopted: number;
  readonly archivedHistory: {
    /** Recorded candidates that are not a service: kept as history. */
    readonly notAdopted: number;
    /** Of those, linked to their invoice archive revision (PR3). */
    readonly linkedToArchive: number;
    readonly notLinkedToArchive: number;
  };
  readonly review: Readonly<Record<LegacyServiceReviewState, number>>;
}

/**
 * The `serviceOutcomes` section (PII-free): this snapshot's live invoices against the
 * candidate rows the section READ, and nothing else — a row the read did not return is
 * `missing`, never assumed.
 */
export function buildServiceOutcomesSection(input: {
  readonly snapshot: Pick<LegacySnapshot, 'fingerprint' | 'synthetic' | 'liveInvoices'>;
  readonly runId: string;
  readonly rows: ReadonlyMap<string, LegacyServiceCandidateRecord>;
}): ServiceOutcomesSection {
  const outcomes = Object.fromEntries(LEGACY_SERVICE_OUTCOMES.map((o) => [o, 0])) as Record<
    LegacyServiceOutcome,
    number
  >;
  const review = Object.fromEntries(LEGACY_SERVICE_REVIEW_STATES.map((s) => [s, 0])) as Record<
    LegacyServiceReviewState,
    number
  >;
  let recorded = 0;
  let missing = 0;
  let unrecordable = 0;
  let decidedByAnotherRun = 0;
  let fromAnotherSource = 0;
  let checksumDiffers = 0;
  let adopted = 0;
  let notAdopted = 0;
  let linked = 0;
  for (const invoice of input.snapshot.liveInvoices) {
    if (!recordableKey(invoice.idInvoice)) {
      unrecordable += 1;
      continue;
    }
    const row = input.rows.get(invoice.idInvoice);
    if (row === undefined) {
      missing += 1;
      continue;
    }
    recorded += 1;
    outcomes[row.outcome] += 1;
    review[row.reviewState] += 1;
    if (row.runId !== input.runId) decidedByAnotherRun += 1;
    if (row.sourceFingerprint !== input.snapshot.fingerprint) fromAnotherSource += 1;
    if (row.invoiceChecksum !== invoice.checksum) checksumDiffers += 1;
    if (isAdoptedOutcome(row.outcome)) adopted += 1;
    else {
      notAdopted += 1;
      if (row.archiveId !== null) linked += 1;
    }
  }
  const candidates = input.snapshot.liveInvoices.length;
  const sum = Object.values(outcomes).reduce((a, b) => a + b, 0);
  return {
    version: LEGACY_SERVICE_OUTCOMES_SECTION_VERSION,
    sourceFingerprint: input.snapshot.fingerprint,
    synthetic: input.snapshot.synthetic,
    runId: input.runId,
    candidates,
    recorded,
    outcomes,
    invariant: {
      statement: 'every service candidate assigned exactly one deterministic outcome',
      holds:
        missing === 0 &&
        unrecordable === 0 &&
        decidedByAnotherRun === 0 &&
        fromAnotherSource === 0 &&
        checksumDiffers === 0 &&
        sum === candidates,
      missing,
      unrecordable,
      decidedByAnotherRun,
      fromAnotherSource,
      checksumDiffers,
    },
    adopted,
    archivedHistory: {
      notAdopted,
      linkedToArchive: linked,
      notLinkedToArchive: notAdopted - linked,
    },
    review,
  };
}
