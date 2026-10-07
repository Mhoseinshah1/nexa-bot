import { z } from 'zod';
import { LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY } from './legacy-product-review.js';

/**
 * Mirza migration PR3 — the legacy invoice archive (`docs/legacy-migration/importer.md`
 * §Invoice archive).
 *
 * An archive row is ONE revision of ONE legacy `invoice` row, read through the
 * `invoice-archive` read set and kept as read-only HISTORY. It is never an order, a payment,
 * a wallet entry, a service, a provisioning operation or revenue, and no report reads it.
 *
 * - Keyed by the tenant and the legacy `id_invoice` exactly as read — whatever its shape,
 *   so an id the importer cannot map (`INVOICE_KEY_INVALID`) is still archived.
 * - Append-only: a newer snapshot appends a REVISION when the row (or its source-derived
 *   context) changed, and writes nothing when it did not. Never an UPDATE, never a
 *   duplicate, never a delete; an invoice a later snapshot no longer has stays archived and
 *   is counted as missing from that snapshot.
 * - Lossless: the row's cells are kept verbatim beside the validated normalised fields.
 * - Each revision carries its provenance: the v1 source fingerprint, the read set
 *   fingerprint and the ingest run.
 */

/**
 * The source-derived migration CLASS of an archived invoice: deterministic, first match
 * wins, decided from the invoice row and the `user`/`product` tables of the SAME snapshot
 * only — never from a panel map, a live inventory or NEXA's own data. For a LIVE invoice the
 * first four are exactly the importer's own source-only steps (`decideServiceCandidate`),
 * in its order; the adoption outcome of a `LIVE_CANDIDATE` (PANEL_UNMAPPED,
 * PROVIDER_MISSING, PRODUCT_UNRESOLVED, ADOPTION_ELIGIBLE, …) is the importer's, decided
 * against the panel map and the live inventory, and is not stored here.
 */
export const LEGACY_INVOICE_ARCHIVE_CLASSES = [
  /** `id_invoice` is outside the evidenced key shape (importer: INVOICE_KEY_INVALID). */
  'KEY_SHAPE_UNRECOGNISED',
  /** `is_test` = 1: a legacy trial (importer: TEST_INVOICE_SKIPPED, history only). */
  'TEST',
  /** `is_test` is neither 0 nor 1 (importer: INVALID_SOURCE_ROW). */
  'TEST_FLAG_INVALID',
  /**
   * `id_user` is NULL or names no row of the legacy `user` table (importer: ORPHAN). Kept
   * reviewable; never given an owner.
   */
  'ORPHAN_OWNER',
  /** `Status` is not one of the live statuses: the importer never decides it. History. */
  'NOT_LIVE',
  /**
   * Live, with an empty `code_panel`. Owner decision 8 (2026-10-07): NEVER adopted
   * automatically; archived history until an explicit, audited operator review action.
   */
  'NO_PANEL',
  /** Every source-derived check holds; the importer's adoption decides the rest. */
  'LIVE_CANDIDATE',
] as const;
export type LegacyInvoiceArchiveClass = (typeof LEGACY_INVOICE_ARCHIVE_CLASSES)[number];
export const legacyInvoiceArchiveClassSchema = z.enum(LEGACY_INVOICE_ARCHIVE_CLASSES);

/** How the invoice's `code_product` relates to the legacy `product` table of the same snapshot. */
export const LEGACY_INVOICE_PRODUCT_REFS = [
  /** NULL or blank. */
  'NONE',
  /** The trimmed code is a `code_product` of the legacy `product` table. */
  'NAMED',
  /** A code the legacy `product` table does not have. */
  'NOT_IN_PRODUCT_TABLE',
] as const;
export type LegacyInvoiceProductRef = (typeof LEGACY_INVOICE_PRODUCT_REFS)[number];

/** Why a revision was appended. */
export const LEGACY_INVOICE_REVISION_REASONS = [
  /** The first snapshot that had this invoice. */
  'FIRST_SEEN',
  /** A cell of the row changed. */
  'ROW_CHANGED',
  /** The row is identical; its source-derived context (owner present, product named) is not. */
  'CONTEXT_CHANGED',
] as const;
export type LegacyInvoiceRevisionReason = (typeof LEGACY_INVOICE_REVISION_REASONS)[number];

/**
 * Why a normalised field is NULL. Closed: a free-text note is where a guess would hide. The
 * raw cell is always kept.
 */
export const LEGACY_INVOICE_PARSE_NOTES = [
  /** The source has no such column. */
  'ABSENT',
  /** NULL, or only whitespace. */
  'EMPTY',
  /** Not the deterministic grammar (whole Toman in ASCII digits). */
  'NOT_A_NUMBER',
  /** A number beyond NEXA's bound for the field. */
  'OUT_OF_RANGE',
  /** Not a format the evidence proves (`time_sell`: unix seconds only). */
  'FORMAT_UNKNOWN',
] as const;
export type LegacyInvoiceParseNote = (typeof LEGACY_INVOICE_PARSE_NOTES)[number];

/**
 * An ingest run of the archive. STAGING → VERIFIED → COMPLETED, or STAGING → FAILED. Every
 * transition is a conditional UPDATE naming its `from` state. Revisions are written only
 * by a VERIFIED run, and are visible only once their run is COMPLETED.
 */
export const LEGACY_INVOICE_ARCHIVE_RUN_STATES = [
  /** The approved read is being delivered into the run's staging rows. Nothing is archived. */
  'STAGING',
  /** The whole read was delivered, verified and staged; its revisions are being written. */
  'VERIFIED',
  /** Every staged invoice is accounted for; the run's revisions are visible. */
  'COMPLETED',
  /** The read did not complete as approved. Its staging rows are deleted; nothing archived. */
  'FAILED',
] as const;
export type LegacyInvoiceArchiveRunState = (typeof LEGACY_INVOICE_ARCHIVE_RUN_STATES)[number];

/** Why a STAGING run failed. Closed. */
export const LEGACY_INVOICE_ARCHIVE_RUN_FAILURES = [
  /** The delivery pass read other rows than the verified pass (`READ_SET_SNAPSHOT_DIVERGED`). */
  'SNAPSHOT_DIVERGED',
  /** A later run found it STAGING: its process died mid-read. */
  'ABANDONED',
  /** The staged rows do not add up to the verified read's row counts. */
  'STAGED_COUNT_MISMATCH',
  /** Two source rows of one table share a key. Nothing is archived until a person looks. */
  'SOURCE_KEY_DUPLICATED',
  /** A cell PostgreSQL cannot hold verbatim (a NUL character), or a key too long to index. */
  'CELL_UNREPRESENTABLE',
  /** Anything else stopped the staging (a lost claim, a stopped scope, a database error). */
  'INTERRUPTED',
] as const;
export type LegacyInvoiceArchiveRunFailure = (typeof LEGACY_INVOICE_ARCHIVE_RUN_FAILURES)[number];

/**
 * The legacy cells that are PERSONAL DATA: redacted for a reader without
 * `legacy.invoices.pii.view`. `id_user` and `refral` are Telegram ids, `username` is the
 * legacy account name, `note` is text the customer typed (the fork's config name).
 */
export const LEGACY_INVOICE_PII_COLUMNS = ['id_user', 'username', 'refral', 'note'] as const;

/** The currency the owner stated for Mirza prices (owner decision 7, 2026-10-07). */
export const LEGACY_INVOICE_PRICE_CURRENCY = LEGACY_PRODUCT_HISTORICAL_PRICE_CURRENCY;

export const LEGACY_INVOICE_ARCHIVE_ERROR_CODES = {
  NOT_FOUND: 'legacy_invoice_archive.not_found',
  REQUEST_INVALID: 'legacy_invoice_archive.request_invalid',
  SCOPE_STOPPED: 'legacy_invoice_archive.scope_stopped',
  /** A run is not in the state this step moves from (a second writer, or a stale step). */
  RUN_CONFLICT: 'legacy_invoice_archive.run_conflict',
} as const;

/** The audit actions the archive writes. Run actions carry counts and hashes, never a cell. */
export const LEGACY_INVOICE_ARCHIVE_AUDIT_ACTIONS = {
  runStarted: 'legacy.invoice_archive.run_started',
  runVerified: 'legacy.invoice_archive.run_verified',
  runCompleted: 'legacy.invoice_archive.run_completed',
  runFailed: 'legacy.invoice_archive.run_failed',
  /** A reader with `legacy.invoices.pii.view` opened a row unredacted. */
  piiView: 'legacy.invoice_archive.pii_view',
  /** A search BY personal data (filter NAMES are recorded, never the values). */
  piiSearch: 'legacy.invoice_archive.pii_search',
} as const;

export const LEGACY_INVOICE_ARCHIVE_PAGE_DEFAULT = 50;
export const LEGACY_INVOICE_ARCHIVE_PAGE_MAX = 100;
/** The longest search term a filter accepts (the legacy columns are varchar(200)–(300)). */
export const LEGACY_INVOICE_ARCHIVE_SEARCH_MAX = 300;

// --- HTTP ---------------------------------------------------------------------------------

export const LEGACY_INVOICE_ARCHIVE_ROUTES = {
  list: '/legacy-invoices',
  summary: '/legacy-invoices/summary',
  detail: (id: string) => `/legacy-invoices/rows/${encodeURIComponent(id)}`,
} as const;

const searchTerm = z
  .string()
  .trim()
  .min(1)
  .max(LEGACY_INVOICE_ARCHIVE_SEARCH_MAX)
  .refine((value) => !/\p{Cc}/u.test(value), { message: 'no control characters' });
const parseNote = z.enum(LEGACY_INVOICE_PARSE_NOTES);

/**
 * One archived revision as the Web Admin renders it. Legacy values are strings AS READ.
 * `legacyUserId` and `username` are null when `piiRedacted` (the reader lacks
 * `legacy.invoices.pii.view`). Money is a decimal string of IRT minor units.
 */
export const legacyInvoiceArchiveRowViewSchema = z.object({
  id: z.string(),
  invoiceKey: z.string(),
  revision: z.number().int().positive(),
  revisionReason: z.enum(LEGACY_INVOICE_REVISION_REASONS),
  keyShapeEvidenced: z.boolean(),
  classification: legacyInvoiceArchiveClassSchema,
  live: z.boolean(),
  status: z.string().nullable(),
  isTest: z.boolean().nullable(),
  ownerPresent: z.boolean(),
  piiRedacted: z.boolean(),
  legacyUserId: z.string().nullable(),
  username: z.string().nullable(),
  panelCode: z.string().nullable(),
  productCode: z.string().nullable(),
  productRef: z.enum(LEGACY_INVOICE_PRODUCT_REFS),
  productName: z.string().nullable(),
  /** The `price_product` cell verbatim — history, never a price. */
  priceRaw: z.string().nullable(),
  priceMinor: z.string().nullable(),
  priceCurrency: z.literal(LEGACY_INVOICE_PRICE_CURRENCY).nullable(),
  priceNote: parseNote.nullable(),
  soldAtRaw: z.string().nullable(),
  soldAt: z.iso.datetime().nullable(),
  soldAtNote: parseNote.nullable(),
  rowChecksum: z.string(),
  sourceFingerprint: z.string(),
  readSetFingerprint: z.string(),
  runId: z.string(),
  archivedAt: z.iso.datetime(),
});
export type LegacyInvoiceArchiveRowView = z.infer<typeof legacyInvoiceArchiveRowViewSchema>;

export const legacyInvoiceArchiveListQuerySchema = z.object({
  /** The invoice id, or its beginning, exactly as stored (case-sensitive). */
  invoiceId: searchTerm.optional(),
  /** PII: the legacy owner's id, exactly. Needs `legacy.invoices.pii.view`. */
  legacyUserId: searchTerm.optional(),
  /** PII: the legacy account username or its beginning, case-insensitive. Needs PII. */
  username: searchTerm.optional(),
  status: searchTerm.optional(),
  panelCode: searchTerm.optional(),
  productCode: searchTerm.optional(),
  classification: legacyInvoiceArchiveClassSchema.optional(),
  test: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().positive().max(LEGACY_INVOICE_ARCHIVE_PAGE_MAX).optional(),
  /** The `nextCursor` of the page before: opaque. */
  after: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,2000}$/u)
    .optional(),
});
export type LegacyInvoiceArchiveListQuery = z.infer<typeof legacyInvoiceArchiveListQuerySchema>;

export const legacyInvoiceArchiveListResponseSchema = z.object({
  rows: z.array(legacyInvoiceArchiveRowViewSchema),
  nextCursor: z.string().nullable(),
});
export type LegacyInvoiceArchiveListResponse = z.infer<
  typeof legacyInvoiceArchiveListResponseSchema
>;

export const legacyInvoiceArchiveRevisionSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  revisionReason: z.enum(LEGACY_INVOICE_REVISION_REASONS),
  classification: legacyInvoiceArchiveClassSchema,
  rowChecksum: z.string(),
  sourceFingerprint: z.string(),
  readSetFingerprint: z.string(),
  runId: z.string(),
  archivedAt: z.iso.datetime(),
  /** False while its run is still being written (not yet COMPLETED). */
  visible: z.boolean(),
});
export type LegacyInvoiceArchiveRevision = z.infer<typeof legacyInvoiceArchiveRevisionSchema>;

/** What the importer has recorded for this invoice key, if anything: codes only. */
export const legacyInvoiceImportOutcomeSchema = z.object({
  status: z.string(),
  reasonCode: z.string().nullable(),
  reviewState: z.string().nullable(),
  entityType: z.string().nullable(),
});

export const legacyInvoiceArchiveDetailResponseSchema = z.object({
  row: legacyInvoiceArchiveRowViewSchema,
  /** Every legacy cell of this revision verbatim; a PII cell is null when redacted. */
  raw: z.record(z.string(), z.string().nullable()),
  /** The PII columns whose cells `raw` redacts (empty when the reader holds PII). */
  redactedColumns: z.array(z.string()),
  revisions: z.array(legacyInvoiceArchiveRevisionSchema),
  importOutcome: legacyInvoiceImportOutcomeSchema.nullable(),
});
export type LegacyInvoiceArchiveDetailResponse = z.infer<
  typeof legacyInvoiceArchiveDetailResponseSchema
>;

export const legacyInvoiceArchiveRunViewSchema = z.object({
  id: z.string(),
  state: z.enum(LEGACY_INVOICE_ARCHIVE_RUN_STATES),
  failureCode: z.enum(LEGACY_INVOICE_ARCHIVE_RUN_FAILURES).nullable(),
  readSetFingerprint: z.string(),
  sourceFingerprint: z.string(),
  synthetic: z.boolean(),
  /** The read's exact row counts (null until VERIFIED). */
  sourceInvoiceRows: z.number().int().nullable(),
  insertedNew: z.number().int(),
  insertedRevision: z.number().int(),
  unchanged: z.number().int(),
  /** Archived invoices this run's snapshot no longer has (never deleted). */
  missingInSnapshot: z.number().int().nullable(),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type LegacyInvoiceArchiveRunView = z.infer<typeof legacyInvoiceArchiveRunViewSchema>;

/** Aggregates only: no invoice id, Telegram id or username. */
export const legacyInvoiceArchiveSummaryResponseSchema = z.object({
  /** Distinct archived invoices (their latest visible revision). */
  invoices: z.number().int(),
  revisions: z.number().int(),
  classes: z.record(legacyInvoiceArchiveClassSchema, z.number().int()),
  runs: z.array(legacyInvoiceArchiveRunViewSchema),
});
export type LegacyInvoiceArchiveSummaryResponse = z.infer<
  typeof legacyInvoiceArchiveSummaryResponseSchema
>;
