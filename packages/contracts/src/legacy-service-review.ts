import { z } from 'zod';

/**
 * Mirza migration PR5 — legacy service candidates: one deterministic adoption outcome per
 * live legacy invoice, and the operator's review of the ones that were not adopted
 * (`docs/legacy-migration/service-review.md`).
 *
 * Every live invoice the importer considers as a service gets EXACTLY ONE outcome per run,
 * recorded on its candidate row. An invoice that is not adopted is never discarded: it stays
 * archived history (its candidate row links the invoice archive's revision, PR3), and a
 * person may review it.
 *
 * Owner decision 8 (2026-10-07): an invoice whose `code_panel` is empty or NULL is NEVER
 * adopted automatically. It is `NO_PANEL`; only an explicit operator ADOPT approval —
 * audited, permissioned, executed by the next import run, which re-runs every adoption check
 * and adopts through the one P6 path, with no provider write — may adopt it. A panel is
 * never guessed (panel 8255 included): the operator names a MAPPED panel whose complete
 * inventory holds the account.
 */

/**
 * Where a live legacy invoice ended, one per candidate per run. A closed set: the
 * reconciliation requires these to add up to the candidates, so no invoice can fall out of
 * the report.
 */
export const LEGACY_SERVICE_OUTCOMES = [
  /** Adopted by THIS run (automatically, or an operator's approval this run executed). */
  'ADOPTED',
  /** Adopted by an earlier run. Never "unadopted", whatever a later snapshot says. */
  'ALREADY_ADOPTED',
  /**
   * Every check holds and nothing adopted it: the adoption step was not wired, or a person
   * kept the invoice as history (which no run overrides until it is reopened).
   */
  'ADOPTION_ELIGIBLE',
  /** `id_invoice` is outside the evidenced key shape: no map row can name it. */
  'INVOICE_KEY_INVALID',
  /** `is_test = 1`: a legacy trial. Not adopted (registered decision). */
  'TEST_INVOICE_SKIPPED',
  /** On a panel the operator declared a test panel. */
  'TEST_PANEL_SKIPPED',
  /** `is_test` is neither 0 nor 1, or the adoption refused a value it would not compare. */
  'INVALID_SOURCE_ROW',
  /** No legacy user owns it. */
  'ORPHAN',
  /** Its legacy user was not imported as a customer (or the customer is missing now). */
  'CUSTOMER_NOT_IMPORTED',
  /** The legacy username is not one the matcher compares. */
  'INVALID_USERNAME',
  /** A panel the decision depends on has no complete inventory (e.g. TOTAL_CHANGED). */
  'INVENTORY_INCOMPLETE',
  /** Owner decision 8: `code_panel` is empty or NULL. Never adopted automatically. */
  'NO_PANEL',
  /** A `code_panel` the panel map does not map (unresolved, or forgotten). */
  'PANEL_UNMAPPED',
  /** The mapped panel's complete inventory has no account of that name. */
  'PROVIDER_MISSING',
  /** A declared-missing panel code whose name is held on two or more production panels. */
  'AMBIGUOUS_PANEL',
  /** Ambiguous username: one panel holds several spellings that fold to the name. */
  'USERNAME_CASE_COLLISION',
  /**
   * Ambiguous ownership: two or more live invoices of DIFFERENT legacy owners claim the same
   * account, or the account's name is already a NEXA service or reservation, or the customer
   * found is not the one expected. Never a silent pick.
   */
  'AMBIGUOUS_OWNERSHIP',
  /** The productless/custom shape is refused, or the account is in a state NEXA does not hold. */
  'UNSUPPORTED_SHAPE',
  /** No compatible NEXA product: a named product not mapped, or a shape without a tariff. */
  'PRODUCT_UNRESOLVED',
  /** The panel is not one an adoption may address (not a RickPanel). */
  'SUBSCRIPTION_REF_BLOCKED',
  /** The account's runtime facts could not be read; the next run reads again. */
  'PROVIDER_READ_FAILED',
  /** A person closed the invoice's review row in the terminal queue; no run acts on it. */
  'REVIEW_CLOSED',
] as const;
export type LegacyServiceOutcome = (typeof LEGACY_SERVICE_OUTCOMES)[number];
export const legacyServiceOutcomeSchema = z.enum(LEGACY_SERVICE_OUTCOMES);

/** The outcomes whose candidate IS a NEXA service. Every other outcome is archived history. */
export const LEGACY_SERVICE_ADOPTED_OUTCOMES = [
  'ADOPTED',
  'ALREADY_ADOPTED',
] as const satisfies readonly LegacyServiceOutcome[];

/**
 * The outcomes an operator may ask to adopt: the ones a person can clear (name a mapped
 * panel, map a product, wait for a complete inventory or a readable account). An approval is
 * only a request — the run that executes it re-runs every check and adopts nothing a check
 * refuses. Deliberately absent: a key, test, orphan, username or shape problem no decision
 * can fix; an ambiguous username or ownership (resolved by keeping the wrong claims as
 * history, never by picking one); a closed review row (reopen it in the terminal queue).
 */
export const LEGACY_SERVICE_ADOPTABLE_OUTCOMES = [
  'ADOPTION_ELIGIBLE',
  'NO_PANEL',
  'PANEL_UNMAPPED',
  'PROVIDER_MISSING',
  'AMBIGUOUS_PANEL',
  'PRODUCT_UNRESOLVED',
  'INVENTORY_INCOMPLETE',
  'PROVIDER_READ_FAILED',
  'CUSTOMER_NOT_IMPORTED',
] as const satisfies readonly LegacyServiceOutcome[];

/**
 * The outcomes for which the operator MUST name the panel: the invoice names none the map
 * resolves. For every other adoptable outcome the panel is the one the map gives, and naming
 * a different one is refused (an explicit mapping is never overridden by a click).
 */
export const LEGACY_SERVICE_PANEL_REQUIRED_OUTCOMES = [
  'NO_PANEL',
  'PANEL_UNMAPPED',
  'AMBIGUOUS_PANEL',
] as const satisfies readonly LegacyServiceOutcome[];

/**
 * Where a candidate stands with a person. Every transition is a conditional UPDATE naming its
 * `from` states and the version the operator saw.
 *
 * - `OPEN` — nobody has decided. Every candidate that is not a service enters here.
 * - `ACKNOWLEDGED` — a person saw it. A later run may still adopt it if its blockers clear;
 *   a run whose outcome differs puts it back OPEN (the acknowledgement was of other facts).
 * - `KEPT_AS_HISTORY` — a person decided it stays history: no run adopts it, automatically
 *   or otherwise, and it does not count as a claim on its account, until it is reopened.
 * - `ADOPT_APPROVED` — a person approved its adoption (bound to the invoice checksum and the
 *   outcome they saw, and to a panel when the invoice names none). Executed by the next
 *   import run.
 * - `ADOPTING` — an import run claimed the approval and is executing it. A crashed run's
 *   claim is executed again by the resume: the adoption is idempotent per invoice.
 * - `ADOPTED` — it is a NEXA service. Terminal.
 */
export const LEGACY_SERVICE_REVIEW_STATES = [
  'OPEN',
  'ACKNOWLEDGED',
  'KEPT_AS_HISTORY',
  'ADOPT_APPROVED',
  'ADOPTING',
  'ADOPTED',
] as const;
export type LegacyServiceReviewState = (typeof LEGACY_SERVICE_REVIEW_STATES)[number];
export const legacyServiceReviewStateSchema = z.enum(LEGACY_SERVICE_REVIEW_STATES);

/** The decisions a person records from OPEN (ACKNOWLEDGE) or OPEN | ACKNOWLEDGED (KEEP). */
export const LEGACY_SERVICE_REVIEW_DECISIONS = ['ACKNOWLEDGE', 'KEEP_AS_HISTORY'] as const;
export type LegacyServiceReviewDecision = (typeof LEGACY_SERVICE_REVIEW_DECISIONS)[number];

/** The states a reopen moves back to OPEN. `ADOPTING` and `ADOPTED` are never reopened. */
export const LEGACY_SERVICE_REOPENABLE_STATES = [
  'ACKNOWLEDGED',
  'KEPT_AS_HISTORY',
  'ADOPT_APPROVED',
] as const satisfies readonly LegacyServiceReviewState[];

/**
 * Why an approved adoption was NOT executed by the run that tried it (the candidate goes back
 * to OPEN, carrying the code). Every adoption refusal is one of the outcomes, plus:
 */
export const LEGACY_SERVICE_APPROVAL_REFUSALS = [
  /** The invoice is no longer live in the snapshot the run read. */
  'NOT_LIVE',
  /** The invoice's row differs from the one the approval was bound to. */
  'SOURCE_CHANGED',
  /** The approved panel is not a panel the run's panel map maps explicitly. */
  'PANEL_NOT_MAPPED',
  /** The invoice's code maps to another panel: an explicit mapping is never overridden. */
  'PANEL_CONFLICTS_WITH_MAP',
  ...LEGACY_SERVICE_OUTCOMES.filter(
    (o) => o !== 'ADOPTED' && o !== 'ALREADY_ADOPTED' && o !== 'ADOPTION_ELIGIBLE',
  ),
] as const;
export type LegacyServiceApprovalRefusal = (typeof LEGACY_SERVICE_APPROVAL_REFUSALS)[number];

export const LEGACY_SERVICE_REVIEW_ERROR_CODES = {
  NOT_FOUND: 'legacy_service_candidate.not_found',
  /** The candidate is not in a state this command moves from. */
  NOT_IN_STATE: 'legacy_service_candidate.not_in_state',
  /** Not at the version the operator saw: refused, never applied over the newer state. */
  VERSION_CONFLICT: 'legacy_service_candidate.version_conflict',
  /** The candidate's outcome is not one an ADOPT approval may be requested for. */
  NOT_ADOPTABLE: 'legacy_service_candidate.not_adoptable',
  /**
   * The request's panel is missing where the invoice names none, names a panel the latest
   * evidence does not show as a MAPPED panel holding the account, or differs from the panel
   * the map gives.
   */
  PANEL_REFUSED: 'legacy_service_candidate.panel_refused',
  REQUEST_INVALID: 'legacy_service_candidate.request_invalid',
  SCOPE_STOPPED: 'legacy_service_candidate.scope_stopped',
} as const;

/** The audit actions candidates write. */
export const LEGACY_SERVICE_REVIEW_AUDIT_ACTIONS = {
  /** The importer recorded a batch of candidate outcomes (`maintenance.run`): counts only. */
  recorded: 'legacy.service_candidate.recorded',
  /** ACKNOWLEDGE or KEEP_AS_HISTORY (`legacy.services.decide`). */
  decide: 'legacy.service_candidate.decide',
  /** An ADOPT approval (`legacy.services.decide`). */
  approveAdoption: 'legacy.service_candidate.approve_adoption',
  /** Back to OPEN (`legacy.services.decide`). */
  reopen: 'legacy.service_candidate.reopen',
  /** An import run executed an approval: adopted (`maintenance.run`). */
  approvalExecuted: 'legacy.service_candidate.approval_executed',
  /** An import run refused an approval; the candidate is OPEN again (`maintenance.run`). */
  approvalRefused: 'legacy.service_candidate.approval_refused',
  /**
   * An import run on a production-like target found a SYNTHETIC approval and did not act on
   * it (`maintenance.run`). Nothing changed; a person investigates.
   */
  approvalSyntheticRefused: 'legacy.service_candidate.approval_synthetic_refused',
} as const;

export const LEGACY_SERVICE_REVIEW_REASON_MAX_LENGTH = 500;
export const LEGACY_SERVICE_REVIEW_PAGE_MAX = 200;
/** The longest invoice key a candidate holds (the invoice archive's bound). */
export const LEGACY_SERVICE_CANDIDATE_KEY_MAX = 1000;
export const LEGACY_SERVICE_REVIEW_SEARCH_MAX = 300;

// --- evidence -------------------------------------------------------------------------------

/** How the panel map classes the invoice's `code_panel`. */
export const LEGACY_SERVICE_PANEL_CODE_CLASSES = [
  'EMPTY',
  'MAPPED',
  'TEST',
  'DECLARED_MISSING',
  'DECLARED_UNRESOLVED',
  'UNMAPPED',
] as const;

/**
 * The inventory and decision evidence behind an outcome, as the run that decided it read it.
 * Codes, NEXA ids and counts only: never a legacy username, a Telegram id, a provider
 * spelling or a subscription link.
 */
export const legacyServiceEvidenceSchema = z.object({
  panelCodeClass: z.enum(LEGACY_SERVICE_PANEL_CODE_CLASSES),
  /** The NEXA panel the map gives the code; null when it gives none. */
  mappedPanelId: z.string().nullable(),
  customer: z.enum(['IMPORTED', 'NOT_IMPORTED', 'ORPHAN']),
  /**
   * Every production panel whose COMPLETE inventory holds the invoice's lowercase name: how
   * many spellings fold to it, the account state when exactly one does, and whether the
   * panel is one the map maps explicitly. Evidence for a person, never a decision: an
   * invoice with no panel is NOT adopted onto a holder.
   */
  holders: z.array(
    z.object({
      panelId: z.string(),
      mapped: z.boolean(),
      spellings: z.number().int().positive(),
      state: z.string().nullable(),
    }),
  ),
  /** Production panels whose inventory was not complete in that run (TOTAL_CHANGED etc.). */
  incompletePanels: z.array(z.string()),
  product: z.object({
    path: z.enum(['NAMED_PRODUCT', 'HIDDEN_SHAPE', 'NONE']),
    /** The NEXA product the map gives a named code; null otherwise. */
    productId: z.string().nullable(),
    /** Whether a compatible NEXA product was known to the run. */
    resolved: z.boolean(),
  }),
  /**
   * Live invoices of the snapshot (not kept as history) carrying the same lowercase legacy
   * username, this one included: more than one is worth a look (duplicate claims).
   */
  claims: z.number().int().nonnegative(),
});
export type LegacyServiceEvidence = z.infer<typeof legacyServiceEvidenceSchema>;

// --- the reconciliation section (report) ---------------------------------------------------

/**
 * The version of the `serviceOutcomes` section `reconcile` and `report` print
 * (`docs/legacy-migration/reconciliation.md` §Service outcomes). Aggregates only: counts and
 * codes, never an invoice key, a username or a Telegram id. PR6 folds it, unchanged, into the
 * final report's schema version 2.
 */
export const LEGACY_SERVICE_OUTCOMES_SECTION_VERSION = 'nexa-legacy-service-outcomes/v1' as const;

// --- HTTP ---------------------------------------------------------------------------------

export const LEGACY_SERVICE_REVIEW_ROUTES = {
  list: '/legacy-services',
  summary: '/legacy-services/summary',
  detail: (id: string) => `/legacy-services/${encodeURIComponent(id)}`,
  decide: (id: string) => `/legacy-services/${encodeURIComponent(id)}/decide`,
  adopt: (id: string) => `/legacy-services/${encodeURIComponent(id)}/adopt`,
  reopen: (id: string) => `/legacy-services/${encodeURIComponent(id)}/reopen`,
} as const;

const idempotencyKey = z.string().min(8).max(255);
/** The candidate's `version` as the operator saw it: every decision binds to it. */
const expectedVersion = z.number().int().min(1);
const reason = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_SERVICE_REVIEW_REASON_MAX_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });
/**
 * A code stored TRIMMED (`panel_code`, `product_code` are kept as the importer reads them:
 * trimmed, never empty), so trimming the term is the same comparison.
 */
const codeTerm = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_SERVICE_REVIEW_SEARCH_MAX)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });
/** The invoice key or its beginning, VERBATIM: never trimmed, case-sensitive. */
const verbatimKey = z
  .string()
  .min(1)
  .max(LEGACY_SERVICE_REVIEW_SEARCH_MAX)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });

/** The non-personal summary of the candidate's invoice archive revision (PR3). */
export const legacyServiceArchiveSummarySchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  classification: z.string(),
  status: z.string().nullable(),
  panelCode: z.string().nullable(),
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  /** The `price_product` cell verbatim — history, never a price. */
  priceRaw: z.string().nullable(),
  priceMinor: z.string().nullable(),
  soldAt: z.iso.datetime().nullable(),
  sourceFingerprint: z.string(),
});

export const legacyServiceCandidateViewSchema = z.object({
  id: z.string(),
  invoiceKey: z.string(),
  outcome: legacyServiceOutcomeSchema,
  /** The raw map or adoption reason code behind the outcome, when there is one. */
  blocker: z.string().nullable(),
  reviewState: legacyServiceReviewStateSchema,
  panelCode: z.string().nullable(),
  productCode: z.string().nullable(),
  evidence: legacyServiceEvidenceSchema,
  /** The invoice archive revision this candidate is history in; null when not archived yet. */
  archiveId: z.string().nullable(),
  /** The NEXA service, for an adopted candidate. */
  serviceId: z.string().nullable(),
  approvedPanelId: z.string().nullable(),
  /** Why the last approval was not executed, when it was refused. */
  lastApprovalRefusal: z.string().nullable(),
  decisionReason: z.string().nullable(),
  decidedByAdminId: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  runId: z.string(),
  sourceFingerprint: z.string(),
  invoiceChecksum: z.string(),
  /** The source carried the synthetic-fixture marker: test data, never acted on in production. */
  synthetic: z.boolean(),
  /** When the run's inventory walk that decided it finished (null: no inventory was needed). */
  observedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  firstDecidedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LegacyServiceCandidateView = z.infer<typeof legacyServiceCandidateViewSchema>;

export const legacyServiceCandidateListQuerySchema = z.object({
  outcome: legacyServiceOutcomeSchema.optional(),
  reviewState: legacyServiceReviewStateSchema.optional(),
  panelCode: codeTerm.optional(),
  productCode: codeTerm.optional(),
  invoiceId: verbatimKey.optional(),
  limit: z.coerce.number().int().positive().max(LEGACY_SERVICE_REVIEW_PAGE_MAX).optional(),
  /** The last `id` of the page before (uuid v7: first-decided order). */
  after: z.uuid().optional(),
});
export type LegacyServiceCandidateListQuery = z.infer<typeof legacyServiceCandidateListQuerySchema>;

export const legacyServiceCandidateListResponseSchema = z.object({
  candidates: z.array(legacyServiceCandidateViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyServiceCandidateListResponse = z.infer<
  typeof legacyServiceCandidateListResponseSchema
>;

/** Counts by outcome and by review state. Aggregates only. */
export const legacyServiceCandidateSummaryResponseSchema = z.object({
  candidateCount: z.number().int().nonnegative(),
  byOutcome: z.record(legacyServiceOutcomeSchema, z.number().int().nonnegative()),
  byReviewState: z.record(legacyServiceReviewStateSchema, z.number().int().nonnegative()),
});
export type LegacyServiceCandidateSummaryResponse = z.infer<
  typeof legacyServiceCandidateSummaryResponseSchema
>;

export const legacyServiceCandidateDetailResponseSchema = z.object({
  candidate: legacyServiceCandidateViewSchema,
  /**
   * The archive revision (non-personal fields), or null when the reader does not hold
   * `legacy.invoices.view` or the invoice is not archived yet. Personal data is on the
   * archive's own page, behind its own key.
   */
  archive: legacyServiceArchiveSummarySchema.nullable(),
  /** The importer's map row for the invoice, codes only. */
  importOutcome: z
    .object({
      status: z.string(),
      reasonCode: z.string().nullable(),
      reviewState: z.string().nullable(),
    })
    .nullable(),
  /** The panels an ADOPT approval may name now (mapped holders in the latest evidence). */
  adoptPanels: z.array(z.string()),
});
export type LegacyServiceCandidateDetailResponse = z.infer<
  typeof legacyServiceCandidateDetailResponseSchema
>;

export const legacyServiceCandidateResponseSchema = z.object({
  candidate: legacyServiceCandidateViewSchema,
});
export type LegacyServiceCandidateResponse = z.infer<typeof legacyServiceCandidateResponseSchema>;

export const legacyServiceDecideRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion,
    decision: z.enum(LEGACY_SERVICE_REVIEW_DECISIONS),
    reason,
  })
  .strict();
export type LegacyServiceDecideRequest = z.infer<typeof legacyServiceDecideRequestSchema>;

/**
 * An explicit ADOPT approval. `panelId` is REQUIRED when the invoice names no panel the map
 * resolves (`LEGACY_SERVICE_PANEL_REQUIRED_OUTCOMES`) and refused when it differs from the
 * mapped one. The adoption itself is done by the next import run, after every check again.
 */
export const legacyServiceAdoptRequestSchema = z
  .object({
    idempotencyKey,
    expectedVersion,
    panelId: z.uuid().optional(),
    reason,
  })
  .strict();
export type LegacyServiceAdoptRequest = z.infer<typeof legacyServiceAdoptRequestSchema>;

export const legacyServiceReopenRequestSchema = z
  .object({ idempotencyKey, expectedVersion, reason })
  .strict();
export type LegacyServiceReopenRequest = z.infer<typeof legacyServiceReopenRequestSchema>;
