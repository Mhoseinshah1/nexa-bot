import { z } from 'zod';
import { MAX_DURATION_DAYS, MAX_TRAFFIC_BYTES, PRODUCT_TITLE_MAX_LENGTH } from './catalog.js';
import { uuidV7Schema } from './ids.js';

/**
 * Mirza migration PR2 — the legacy product review (`docs/legacy-product-review-design.md`).
 *
 * A review row is ONE legacy `product` row (keyed by its trimmed `code_product`), read into
 * NEXA through the `products` read set so an operator can decide what it becomes. It is not
 * a product: it cannot be listed, ordered, priced or renewed. A decision maps the code to a
 * NEXA product (an existing one, or a draft created from the review that is INACTIVE,
 * HIDDEN, unpriced, uncategorised and panel-less), or rejects it. Only approved rows whose
 * approval is bound to the CURRENT facts are exported to the importer's panel map
 * (`legacy-import products-export`); nothing is mapped, priced or sold automatically.
 *
 * The historical price is METADATA: the owner states Mirza prices are Toman (IRT, minor
 * exponent 0, so one Toman is one minor unit); the raw text is kept verbatim beside the
 * normalised figure. It never becomes `products.price_*`, a tariff or a quote.
 */

/** Every state a review row can be in. Each transition is a conditional UPDATE naming its `from` states. */
export const LEGACY_PRODUCT_REVIEW_STATES = [
  /** Read, not decided. Its invoices stay `PRODUCT_MAPPING_UNRESOLVED`. */
  'PENDING_REVIEW',
  /** Mapped to an existing NEXA product the operator picked. */
  'APPROVED_EXISTING',
  /** Mapped to a draft product the operator created from the review. */
  'APPROVED_NEW',
  /** The operator decided not to map it. */
  'REJECTED',
  /**
   * A later read saw different facts (or no row at all) for a DECIDED code. The decision no
   * longer exports until the operator decides again. Never silently re-approved.
   */
  'SOURCE_CHANGED',
] as const;
export type LegacyProductReviewState = (typeof LEGACY_PRODUCT_REVIEW_STATES)[number];
export const legacyProductReviewStateSchema = z.enum(LEGACY_PRODUCT_REVIEW_STATES);

/** The states a decision is made FROM (approve-existing, approve-new, reject). */
export const LEGACY_PRODUCT_REVIEW_DECIDABLE_STATES = [
  'PENDING_REVIEW',
  'SOURCE_CHANGED',
] as const satisfies readonly LegacyProductReviewState[];

/** The decided states: what a re-read with changed facts moves to `SOURCE_CHANGED`. */
export const LEGACY_PRODUCT_REVIEW_DECIDED_STATES = [
  'APPROVED_EXISTING',
  'APPROVED_NEW',
  'REJECTED',
] as const satisfies readonly LegacyProductReviewState[];

/** The approved states: the only ones `products-export` may export. */
export const LEGACY_PRODUCT_REVIEW_APPROVED_STATES = [
  'APPROVED_EXISTING',
  'APPROVED_NEW',
] as const satisfies readonly LegacyProductReviewState[];

/** The states that still want an operator. */
export const LEGACY_PRODUCT_REVIEW_ATTENTION_STATES = [
  'PENDING_REVIEW',
  'SOURCE_CHANGED',
] as const satisfies readonly LegacyProductReviewState[];

/** The fields the review PARSES from the raw facts (as a proposal; the operator decides). */
export const LEGACY_PRODUCT_PARSED_FIELDS = [
  'title',
  'trafficBytes',
  'durationDays',
  'historicalPrice',
] as const;
export type LegacyProductParsedField = (typeof LEGACY_PRODUCT_PARSED_FIELDS)[number];

/**
 * Why a field could not be parsed. Closed: a free-text note is where a guess would hide.
 * A field with a note is NULL; the raw cell is always kept in the facts.
 */
export const LEGACY_PRODUCT_PARSE_NOTES = [
  /** The source has no such column. */
  'ABSENT',
  /** NULL, or only whitespace. */
  'EMPTY',
  /** Not the deterministic grammar (whole Toman; decimal GB with at most two places; whole days). */
  'NOT_A_NUMBER',
  /** A number beyond NEXA's own bound for the field. */
  'OUT_OF_RANGE',
  /** `0`: its legacy meaning (unlimited? free?) is not evidenced (OQ-LPR-02). */
  'ZERO_MEANING_UNKNOWN',
  /** The code has more than one legacy row: nothing is parsed until a person looks. */
  'SOURCE_CONFLICT',
] as const;
export type LegacyProductParseNote = (typeof LEGACY_PRODUCT_PARSE_NOTES)[number];

/** Why a code's source is not one clean row. Approval is refused while one holds. */
export const LEGACY_PRODUCT_SOURCE_CONFLICTS = [
  /** Two or more legacy rows share the trimmed `code_product` (OQ-LPR-05). */
  'CODE_DUPLICATED',
] as const;
export type LegacyProductSourceConflict = (typeof LEGACY_PRODUCT_SOURCE_CONFLICTS)[number];

/** The currency the owner stated for Mirza prices (owner decision 7, 2026-10-07). */
export const LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY = 'IRT' as const;

export const LEGACY_PRODUCT_REVIEW_ERROR_CODES = {
  NOT_FOUND: 'legacy_product_review.not_found',
  /** The row is not in a state this command moves from. */
  NOT_IN_STATE: 'legacy_product_review.not_in_state',
  /** The facts are not the ones the operator saw (`expectedFactsChecksum`). */
  FACTS_CHANGED: 'legacy_product_review.facts_changed',
  /**
   * The row is not at the version the operator saw (`expectedVersion`): another decision, a
   * reopen or a read moved it since. Refused, never applied over the newer state.
   */
  VERSION_CONFLICT: 'legacy_product_review.version_conflict',
  /** The latest read has no row for this code: it cannot be approved. */
  SOURCE_ABSENT: 'legacy_product_review.source_absent',
  /** The code has more than one legacy row: it cannot be approved. */
  SOURCE_CONFLICT: 'legacy_product_review.source_conflict',
  /** The product named for approve-existing is not one of this tenant's. */
  PRODUCT_NOT_FOUND: 'legacy_product_review.product_not_found',
  REQUEST_INVALID: 'legacy_product_review.request_invalid',
  SCOPE_STOPPED: 'legacy_product_review.scope_stopped',
} as const;

/** The audit actions the review writes. Every decision is one of the last four. */
export const LEGACY_PRODUCT_REVIEW_AUDIT_ACTIONS = {
  /** The CLI ingest wrote or changed a row (`maintenance.run`, SYSTEM_JOB). */
  read: 'legacy.product_review.read',
  /** The ingest moved a decided row to SOURCE_CHANGED. */
  sourceChanged: 'legacy.product_review.source_changed',
  approveExisting: 'legacy.product_review.approve_existing',
  approveNew: 'legacy.product_review.approve_new',
  reject: 'legacy.product_review.reject',
  reopen: 'legacy.product_review.reopen',
} as const;

export const LEGACY_PRODUCT_REVIEW_REASON_MAX_LENGTH = 500;
/** One page of the review list. The legacy catalogue is small; the cursor is the code. */
export const LEGACY_PRODUCT_REVIEW_PAGE_MAX = 200;

// --- HTTP ---------------------------------------------------------------------------------

export const LEGACY_PRODUCT_REVIEW_ROUTES = {
  list: '/legacy-products',
  detail: (id: string) => `/legacy-products/${encodeURIComponent(id)}`,
  approveExisting: (id: string) => `/legacy-products/${encodeURIComponent(id)}/approve-existing`,
  approveNew: (id: string) => `/legacy-products/${encodeURIComponent(id)}/approve-new`,
  reject: (id: string) => `/legacy-products/${encodeURIComponent(id)}/reject`,
  reopen: (id: string) => `/legacy-products/${encodeURIComponent(id)}/reopen`,
} as const;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u, 'a SHA-256 as 64 lowercase hex characters');
const idempotencyKey = z.string().min(8).max(255);
/** The row's `version` as the operator saw it: every decision and every reopen binds to it. */
const expectedVersion = z.number().int().min(1);
const reason = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_PRODUCT_REVIEW_REASON_MAX_LENGTH)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });

/**
 * One review row, as the Web Admin renders it. Every legacy value is a string AS READ
 * (`facts`, one object per legacy row — normally one); the parsed fields are proposals with
 * their `parseNotes`. Money is a decimal string of minor units.
 */
export const legacyProductReviewViewSchema = z.object({
  id: z.string(),
  codeProduct: z.string(),
  legacyProductId: z.string(),
  state: legacyProductReviewStateSchema,
  facts: z.array(z.record(z.string(), z.string().nullable())),
  factsChecksum: z.string(),
  sourceConflict: z.enum(LEGACY_PRODUCT_SOURCE_CONFLICTS).nullable(),
  title: z.string().nullable(),
  trafficBytes: z.string().nullable(),
  durationDays: z.number().int().nullable(),
  /** The legacy cell verbatim — never parsed into anything but the metadata below. */
  historicalPriceRaw: z.string().nullable(),
  historicalPriceMinor: z.string().nullable(),
  historicalPriceCurrency: z.literal(LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY).nullable(),
  parseNotes: z.partialRecord(
    z.enum(LEGACY_PRODUCT_PARSED_FIELDS),
    z.enum(LEGACY_PRODUCT_PARSE_NOTES),
  ),
  liveInvoiceCount: z.number().int().nonnegative(),
  approvedProductId: z.string().nullable(),
  approvedProductTitle: z.string().nullable(),
  approvedFactsChecksum: z.string().nullable(),
  /** For a SOURCE_CHANGED row: the decision the change invalidated. */
  priorState: legacyProductReviewStateSchema.nullable(),
  decisionReason: z.string().nullable(),
  decidedByAdminId: z.string().nullable(),
  decidedAt: z.iso.datetime().nullable(),
  readFingerprint: z.string(),
  sourceFingerprint: z.string(),
  /**
   * The products read fingerprint of the LATEST completed read that did not have this code
   * (every such read re-acknowledges it); null while the code is present.
   */
  missingSinceReadFingerprint: z.string().nullable(),
  /** Whether `products-export` exports it under its current read fingerprint. */
  exportable: z.boolean(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
export type LegacyProductReviewView = z.infer<typeof legacyProductReviewViewSchema>;

export const legacyProductReviewListQuerySchema = z
  .object({
    state: legacyProductReviewStateSchema.optional(),
    /** `true`: PENDING_REVIEW and SOURCE_CHANGED. Never beside `state`. */
    attention: z.enum(['true']).optional(),
    /** A substring of the code or of the legacy name, as typed. */
    q: z.string().trim().min(1).max(200).optional(),
    limit: z.coerce.number().int().positive().max(LEGACY_PRODUCT_REVIEW_PAGE_MAX).optional(),
    /** The last `codeProduct` of the page before (the code is the row's immutable key). */
    after: z.string().min(1).max(200).optional(),
  })
  .refine((query) => query.state === undefined || query.attention === undefined, {
    message: 'state and attention are exclusive.',
    path: ['attention'],
  });
export type LegacyProductReviewListQuery = z.infer<typeof legacyProductReviewListQuerySchema>;

export const legacyProductReviewListResponseSchema = z.object({
  reviews: z.array(legacyProductReviewViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyProductReviewListResponse = z.infer<typeof legacyProductReviewListResponseSchema>;

export const legacyProductReviewResponseSchema = z.object({
  review: legacyProductReviewViewSchema,
});
export type LegacyProductReviewResponse = z.infer<typeof legacyProductReviewResponseSchema>;

export const legacyProductApproveExistingRequestSchema = z
  .object({
    idempotencyKey,
    /** The facts the operator decided on. A different checksum is refused, never approved. */
    expectedFactsChecksum: sha256Hex,
    expectedVersion,
    productId: uuidV7Schema,
    reason: reason.nullable().default(null),
  })
  .strict();
export type LegacyProductApproveExistingRequest = z.infer<
  typeof legacyProductApproveExistingRequestSchema
>;

/**
 * Approve AS NEW: the draft's title and specification, prefilled from the review and
 * editable. There is deliberately NO price, panel, category, audience or status field — the
 * draft is INACTIVE, HIDDEN, unpriced, uncategorised and panel-less whatever is sent, and
 * the strict schema refuses a body that tries.
 */
export const legacyProductApproveNewRequestSchema = z
  .object({
    idempotencyKey,
    expectedFactsChecksum: sha256Hex,
    expectedVersion,
    title: z.string().trim().min(1).max(PRODUCT_TITLE_MAX_LENGTH),
    durationDays: z.number().int().min(0).max(MAX_DURATION_DAYS),
    /** Bytes, as a decimal string. */
    trafficBytes: z
      .string()
      .regex(/^[0-9]{1,19}$/u)
      .refine((value) => BigInt(value) <= MAX_TRAFFIC_BYTES, {
        message: 'beyond the traffic bound',
      }),
    reason: reason.nullable().default(null),
  })
  .strict();
export type LegacyProductApproveNewRequest = z.infer<typeof legacyProductApproveNewRequestSchema>;

export const legacyProductRejectRequestSchema = z
  .object({ idempotencyKey, expectedFactsChecksum: sha256Hex, expectedVersion, reason })
  .strict();
export type LegacyProductRejectRequest = z.infer<typeof legacyProductRejectRequestSchema>;

export const legacyProductReopenRequestSchema = z
  .object({ idempotencyKey, expectedVersion, reason })
  .strict();
export type LegacyProductReopenRequest = z.infer<typeof legacyProductReopenRequestSchema>;
