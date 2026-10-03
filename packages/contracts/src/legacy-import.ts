/**
 * Migration P4 — legacy import metadata (`docs/legacy-import-metadata.md`).
 *
 * Two tables describe what a legacy import DID, never what the legacy system contained:
 *
 * - `legacy_import_runs` — one row per run: its source fingerprint, mode, lifecycle and
 *   aggregate counters.
 * - `legacy_import_map` — one row per legacy record a run DECIDED something about, unique on
 *   `(tenant_id, legacy_table, legacy_id)`: which NEXA entity it became (if any), the
 *   checksum of the source row it was decided from, and a closed reason code.
 *
 * What this deliberately is NOT: a staging copy of the legacy database. Nothing here carries
 * a raw source row, a free-text error, a phone number, a credential or a subscription link.
 * A warning or a failure is a CODE from the closed sets below, pinned by a CHECK — the same
 * rule `operational_events` follows — so an error blob cannot become the place a secret or a
 * customer record leaks to. The importer that writes these rows (P7) is on HOLD; this is the
 * metadata it will need to resume, reconcile and rerun safely.
 */

/**
 * - `DRY_RUN` — decides and counts, writes nothing to `legacy_import_map`. The repository
 *   refuses a map write under a dry run by construction.
 * - `APPLY` — the run whose decisions become provenance.
 */
export const LEGACY_IMPORT_RUN_MODES = ['DRY_RUN', 'APPLY'] as const;
export type LegacyImportRunMode = (typeof LEGACY_IMPORT_RUN_MODES)[number];

/**
 * - `RUNNING` — at most one per tenant (a partial unique index). A second start with the SAME
 *   source fingerprint and mode resumes it; a different one is refused.
 * - `COMPLETED` / `FAILED` / `ABORTED` — terminal, reached only by a conditional UPDATE from
 *   `RUNNING`. A `FAILED` run carries a failure code; the others do not.
 */
export const LEGACY_IMPORT_RUN_STATUSES = ['RUNNING', 'COMPLETED', 'FAILED', 'ABORTED'] as const;
export type LegacyImportRunStatus = (typeof LEGACY_IMPORT_RUN_STATUSES)[number];
export const LEGACY_IMPORT_RUN_TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'ABORTED'] as const;
export type LegacyImportRunTerminalStatus = (typeof LEGACY_IMPORT_RUN_TERMINAL_STATUSES)[number];

/** Why a run failed, as a code. Never a stack, never a message carrying source data. */
export const LEGACY_IMPORT_RUN_FAILURE_CODES = [
  'SOURCE_UNREADABLE',
  'SOURCE_FINGERPRINT_MISMATCH',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL_ERROR',
] as const;
export type LegacyImportRunFailureCode = (typeof LEGACY_IMPORT_RUN_FAILURE_CODES)[number];

/** What NEXA entity a legacy record became. The id is a NEXA uuid; there is no FK by design. */
export const LEGACY_IMPORT_ENTITY_TYPES = [
  'CUSTOMER',
  'WALLET_ENTRY',
  'SERVICE',
  'ORDER',
  'PANEL',
] as const;
export type LegacyImportEntityType = (typeof LEGACY_IMPORT_ENTITY_TYPES)[number];

/**
 * - `IMPORTED` — became `entity_type`/`entity_id`. Never re-pointed and never downgraded by a
 *   later write: a rerun that disagrees is refused, not applied.
 * - `SKIPPED` — deliberately not imported (a test panel's row, history §19 says not to replay).
 * - `MANUAL_REVIEW` — the importer would have had to guess (§11: no panel match, several).
 * - `FAILED` — an attempt that did not complete; a rerun processes it again.
 */
export const LEGACY_IMPORT_MAP_STATUSES = [
  'IMPORTED',
  'SKIPPED',
  'MANUAL_REVIEW',
  'FAILED',
] as const;
export type LegacyImportMapStatus = (typeof LEGACY_IMPORT_MAP_STATUSES)[number];

/**
 * The closed vocabulary of warnings and errors on a map row. `IMPORTED` may carry one as a
 * warning (an existing customer matched, a negative balance carried); every other status must.
 */
export const LEGACY_IMPORT_REASON_CODES = [
  /** §11: exact lowercase username on no configured RickPanel. */
  'PROVIDER_MISSING',
  /** §11: exact lowercase username on more than one configured RickPanel. */
  'AMBIGUOUS_PANEL',
  /** The legacy `code_panel` has no entry in the explicit legacy→NEXA panel map. */
  'PANEL_UNMAPPED',
  /**
   * P5: one panel holds two or more accounts whose names fold to the row's lowercase name
   * (`Alice`, `alice`); which one the row meant would be a guess.
   */
  'USERNAME_CASE_COLLISION',
  /** §19: test panel rows are skipped. */
  'TEST_PANEL',
  /** §19: history the program says is archive, not import. */
  'HISTORY_NOT_IMPORTED',
  /** §19: matched an existing `(tenant, telegram_user_id)` customer instead of creating one. */
  'EXISTING_CUSTOMER',
  /** §8: a negative legacy balance, carried as recorded and never collected. */
  'NEGATIVE_BALANCE',
  /** The source row failed validation (shape, type, range). */
  'INVALID_SOURCE_ROW',
  /** A provider READ failed; nothing was decided from it. */
  'PROVIDER_READ_FAILED',
  /** An unexpected failure inside the importer. */
  'INTERNAL_ERROR',
] as const;
export type LegacyImportReasonCode = (typeof LEGACY_IMPORT_REASON_CODES)[number];

/** A legacy table name as the source spells it: a plain SQL identifier, nothing else. */
export const LEGACY_TABLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;
/** A legacy primary key as text: printable, bounded, no whitespace. */
export const LEGACY_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** SHA-256, lowercase hex: the source fingerprint and every row checksum. */
export const LEGACY_SHA256_PATTERN = /^[0-9a-f]{64}$/;
/** A code version: a git SHA or a release string. */
export const LEGACY_CODE_VERSION_PATTERN = /^[A-Za-z0-9._+-]{1,64}$/;

export const LEGACY_IMPORT_ERROR_CODES = {
  RUN_NOT_FOUND: 'legacy_import.run_not_found',
  /** Another run is RUNNING for this tenant with a different source or mode. */
  RUN_CONFLICT: 'legacy_import.run_conflict',
  /** The run is not RUNNING (or is a DRY_RUN), so it may not write. */
  RUN_NOT_WRITABLE: 'legacy_import.run_not_writable',
  /** A value outside the declared shape (table, id, checksum, status/reason pairing). */
  INVALID: 'legacy_import.invalid',
} as const;
