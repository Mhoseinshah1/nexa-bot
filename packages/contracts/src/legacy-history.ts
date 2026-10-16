import { z } from 'zod';
import { LEGACY_HISTORY_RECORD_TYPES } from './legacy-nxpkg.js';
import { LEGACY_INVOICE_ARCHIVE_CLASSES } from './legacy-invoice-archive.js';
import { LEGACY_SERVICE_OUTCOMES, LEGACY_SERVICE_REVIEW_STATES } from './legacy-service-review.js';

/**
 * Mirza `.nxpkg` importer — the archived Mirza history of a customer
 * (`docs/legacy-migration/nxpkg-importer.md` §5), read on Customer 360.
 *
 * `legacy_history_records` is visible history only: nothing on this surface writes, and no
 * record ever changed a balance, an order, a service or a role. Reading it is charged on
 * `users.view` (the customer page) and `legacy.history.view` (MEDIUM, owner-only by default).
 * Personal and free-text fields (Telegram ids, usernames, message text, raw source columns)
 * are returned null unless the reader also holds `legacy.invoices.pii.view`, the legacy
 * archives' personal-data key; each unredacted page is audited (ids and counts, never values).
 */

/** The largest page the history endpoint returns. */
export const LEGACY_HISTORY_PAGE_MAX = 100;
export const LEGACY_HISTORY_PAGE_DEFAULT = 25;
/** The deepest offset a page may start at: a customer's history is browsed, not dumped. */
export const LEGACY_HISTORY_OFFSET_MAX = 100_000;

export const legacyHistoryListQuerySchema = z
  .object({
    type: z.enum(LEGACY_HISTORY_RECORD_TYPES).optional(),
    offset: z.coerce.number().int().min(0).max(LEGACY_HISTORY_OFFSET_MAX).optional(),
    limit: z.coerce.number().int().min(1).max(LEGACY_HISTORY_PAGE_MAX).optional(),
  })
  .strict();
export type LegacyHistoryListQuery = z.infer<typeof legacyHistoryListQuerySchema>;

/** A scalar the card can show beside the record type; never a personal value. */
const summaryValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const legacyHistoryItemSchema = z.object({
  id: z.string(),
  recordType: z.enum(LEGACY_HISTORY_RECORD_TYPES),
  /** Only when the package stated an unambiguous instant (offset or Unix time); else null. */
  occurredAt: z.iso.datetime().nullable(),
  /** The package's own `import_id`. */
  packageImportId: z.string(),
  /** Codes, states and amounts picked from the payload: what the card lists. */
  summary: z.record(z.string(), summaryValue),
  /** The record as packaged, with the personal fields set to null when redacted. */
  payload: z.record(z.string(), z.unknown()),
  /** Dotted paths of the fields set to null; empty when the reader may see personal data. */
  redacted: z.array(z.string()),
  /** The legacy user id (a Telegram id): null when redacted. */
  legacyUserId: z.string().nullable(),
});
export type LegacyHistoryItem = z.infer<typeof legacyHistoryItemSchema>;

export const legacyHistoryResponseSchema = z.object({
  items: z.array(legacyHistoryItemSchema).max(LEGACY_HISTORY_PAGE_MAX),
  /** Records matching the query (the type filter included). */
  matching: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  /** This customer's records per type, whatever the filter: drives the grouping. */
  byType: z.array(
    z.object({
      recordType: z.enum(LEGACY_HISTORY_RECORD_TYPES),
      count: z.number().int().nonnegative(),
    }),
  ),
  piiRedacted: z.boolean(),
  /** Archived legacy invoices of this customer; null without `legacy.invoices.view`. */
  invoiceArchive: z.object({ invoices: z.number().int().nonnegative() }).nullable(),
  /** Legacy wallet debts held for review; null without `legacy.debts.view`. */
  walletDebts: z.object({ debts: z.number().int().nonnegative() }).nullable(),
});
export type LegacyHistoryResponse = z.infer<typeof legacyHistoryResponseSchema>;

/**
 * The audit actions of the history archive. The ingest row names the import, the package
 * import id and the per-type counts; a PII reveal names the customer and the record ids.
 * Never a Telegram id, a username or a message.
 */
export const LEGACY_HISTORY_AUDIT_ACTIONS = {
  ingest: 'legacy.history.ingest',
  piiView: 'legacy.history.pii_view',
} as const;

/** The history archive's error codes (the ingest's own refusals carry `LEGACY_NXPKG_ERROR_CODES`). */
export const LEGACY_HISTORY_ERROR_CODES = {
  /** The installation stopped accepting work: the ingest writes nothing. */
  SCOPE_STOPPED: 'legacy_history.scope_stopped',
  REQUEST_INVALID: 'legacy_history.request_invalid',
} as const;

// --- a customer's legacy invoices, with what the import decided about each ------------------

/**
 * Customer 360 — the customer's Mirza INVOICES (the latest visible revision of each
 * `legacy_invoice_archive` row whose `id_user` is the customer's Telegram id), each beside the
 * ONE outcome the importer gave it as a service (`legacy_service_candidates`, joined by the
 * invoice key) when there is one.
 *
 * History, never an order: nothing here is a sale, a payment or a live service. `status` is
 * Mirza's `Status` VERBATIM as of the snapshot; the Web Admin labels only the values whose
 * writer is documented and shows any other as unknown, with the raw value. Charged on
 * `users.view` then `legacy.invoices.view`; the candidate is null for every row unless the
 * reader also holds `legacy.services.view` (`candidatesVisible`); `username` is null unless
 * the reader holds `legacy.invoices.pii.view` (`piiRedacted`), and an unredacted page is
 * audited like the archive's own list.
 */
export const LEGACY_CUSTOMER_INVOICES_PAGE_MAX = 50;
export const LEGACY_CUSTOMER_INVOICES_PAGE_DEFAULT = 20;

export const legacyCustomerInvoicesQuerySchema = z
  .object({
    /** Opaque keyset cursor: the `nextCursor` of the page before (invoice-key order). */
    after: z.string().min(2).max(2000).optional(),
    limit: z.coerce.number().int().min(1).max(LEGACY_CUSTOMER_INVOICES_PAGE_MAX).optional(),
  })
  .strict();
export type LegacyCustomerInvoicesQuery = z.infer<typeof legacyCustomerInvoicesQuerySchema>;

/** What the importer decided about the invoice as a service. Codes and NEXA ids only. */
export const legacyCustomerInvoiceCandidateSchema = z.object({
  id: z.string(),
  outcome: z.enum(LEGACY_SERVICE_OUTCOMES),
  /** The raw map or adoption reason behind the outcome, when there is one. */
  blocker: z.string().nullable(),
  reviewState: z.enum(LEGACY_SERVICE_REVIEW_STATES),
  /** The adopted NEXA service: set exactly when the outcome is ADOPTED or ALREADY_ADOPTED. */
  serviceId: z.string().nullable(),
});
export type LegacyCustomerInvoiceCandidate = z.infer<typeof legacyCustomerInvoiceCandidateSchema>;

export const legacyCustomerInvoiceSchema = z.object({
  /** The archive revision shown (the latest visible one). */
  archiveId: z.string(),
  invoiceKey: z.string(),
  revision: z.number().int().positive(),
  classification: z.enum(LEGACY_INVOICE_ARCHIVE_CLASSES),
  /** `Status` is in the importer's live set. */
  live: z.boolean(),
  /** Mirza's `Status` verbatim (case-sensitive), as of the snapshot. */
  status: z.string().nullable(),
  isTest: z.boolean().nullable(),
  /** The legacy panel account name (personal): null without `legacy.invoices.pii.view`. */
  username: z.string().nullable(),
  panelCode: z.string().nullable(),
  productCode: z.string().nullable(),
  productName: z.string().nullable(),
  /** Historical metadata, never a price anybody is charged: IRT minor units as a decimal. */
  priceMinor: z.string().nullable(),
  priceCurrency: z.literal('IRT').nullable(),
  soldAt: z.iso.datetime().nullable(),
  /** Null when no import run decided it, or when `candidatesVisible` is false. */
  candidate: legacyCustomerInvoiceCandidateSchema.nullable(),
});
export type LegacyCustomerInvoice = z.infer<typeof legacyCustomerInvoiceSchema>;

export const legacyCustomerInvoicesResponseSchema = z.object({
  invoices: z.array(legacyCustomerInvoiceSchema).max(LEGACY_CUSTOMER_INVOICES_PAGE_MAX),
  nextCursor: z.string().nullable(),
  piiRedacted: z.boolean(),
  /** The reader holds `legacy.services.view`: a null `candidate` means "never decided". */
  candidatesVisible: z.boolean(),
});
export type LegacyCustomerInvoicesResponse = z.infer<typeof legacyCustomerInvoicesResponseSchema>;

/**
 * Customer 360 — which of the given services of this customer were ADOPTED from a Mirza
 * invoice (a panel account that existed before NEXA, represented here). Bounded by the page
 * of services the caller is showing; a service of another customer is never answered.
 * Charged on `users.view` then `legacy.services.view`.
 */
export const LEGACY_CUSTOMER_ADOPTIONS_MAX = 50;

export const legacyCustomerAdoptionsQuerySchema = z
  .object({
    /** Comma-separated service ids (uuid), 1 to `LEGACY_CUSTOMER_ADOPTIONS_MAX`. */
    serviceIds: z
      .string()
      .max(LEGACY_CUSTOMER_ADOPTIONS_MAX * 40)
      .transform((value) => value.split(',').filter((part) => part !== ''))
      .pipe(z.array(z.uuid()).min(1).max(LEGACY_CUSTOMER_ADOPTIONS_MAX)),
  })
  .strict();
export type LegacyCustomerAdoptionsQuery = z.infer<typeof legacyCustomerAdoptionsQuerySchema>;

export const legacyCustomerAdoptionsResponseSchema = z.object({
  adoptions: z
    .array(z.object({ serviceId: z.string(), invoiceKey: z.string() }))
    .max(LEGACY_CUSTOMER_ADOPTIONS_MAX),
});
export type LegacyCustomerAdoptionsResponse = z.infer<typeof legacyCustomerAdoptionsResponseSchema>;
