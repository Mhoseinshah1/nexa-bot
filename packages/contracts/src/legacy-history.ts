import { z } from 'zod';
import { LEGACY_HISTORY_RECORD_TYPES } from './legacy-nxpkg.js';

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
