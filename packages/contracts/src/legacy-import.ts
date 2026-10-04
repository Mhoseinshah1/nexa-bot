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
 *   refuses a map write under a dry run by construction; each decision instead increments
 *   the run row's counter for its status (a conditional update under the run lock). A dry
 *   run is NOT resumable — re-processing rows after a crash would count them twice — so a
 *   second start while one is RUNNING is refused with its id, to be aborted.
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

/**
 * The legacy tables a map row may name, each with the ONE primary-key shape the repository
 * evidence establishes for it. A closed set, mirrored exactly by
 * `legacy_import_map_legacy_key_check`.
 *
 * - `user` — `user.id`, which is the customer's Telegram user id: all 197,461 values are
 *   numeric strings (program §19, `docs/legacy-migration/sql-evidence.md`). Digits only, no
 *   leading zero, at most 20. This is the key, and it is expected: the map holds an
 *   identifier, never a credential or free text. A digit string is, by shape alone,
 *   indistinguishable from other digit strings (a phone number among them); the CHECK
 *   cannot and does not claim otherwise. What it does guarantee is that nothing with a
 *   letter, a separator or whitespace — `hunter2`, `password:hunter2`, a name — fits.
 *
 * - `invoice` — `invoice.id_invoice` (`OQ-P4-01`, resolved from MirzaBot's PUBLIC source;
 *   `docs/legacy-import-metadata.md` § "The `invoice` key"). Every revision of
 *   `mahdiMGF2/botmirzapanel` (535 commits, to `92c0ed06`) and `mahdiMGF2/mirza_pro` (508
 *   commits, to `8e551ecf`) declares `id_invoice varchar(200) PRIMARY KEY` and binds it, at
 *   every `INSERT INTO invoice`, to `bin2hex(random_bytes(2|4))` — 4 or 8 lowercase hex — which a
 *   collision fallback may prefix with `rand|random_int(1000000, 9999999)`, seven digits with
 *   no leading zero. Nothing else ever reaches that column. The shape is exactly that union,
 *   and no wider: `^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$`.
 *   CAVEAT: the deployed archive's `invoice` carries columns (`code_panel`, `is_test`, …)
 *   that no public revision declares, so the deployed code is NOT one of the revisions read.
 *   A key outside this shape is therefore refused (a typed `INVALID`, before SQL) — the
 *   importer fails closed rather than widening it; widening is a forward migration made from
 *   the archive's own aggregate (character classes and lengths, never values).
 *   Like `user`, the shape cannot tell one short hex string from another; it does guarantee
 *   that nothing with a letter beyond `f`, an uppercase letter, a separator or whitespace —
 *   `hunter2`, `password:hunter2`, a name, a subscription link — fits.
 *
 * Not here, deliberately: any other table whose primary-key format the evidence does not
 * establish. A table joins this set, and the CHECK, in a forward migration once its key
 * shape is evidenced — never by a guess.
 */
export const LEGACY_IMPORT_SOURCE_TABLES = ['user', 'invoice'] as const;
export type LegacyImportSourceTable = (typeof LEGACY_IMPORT_SOURCE_TABLES)[number];

/** Per table, the key shape. Kept in step with the SQL CHECK by an integration test. */
export const LEGACY_ID_PATTERNS: Readonly<Record<LegacyImportSourceTable, RegExp>> = {
  user: /^[1-9][0-9]{0,19}$/,
  invoice: /^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$/,
};

export function isLegacyImportSourceTable(value: string): value is LegacyImportSourceTable {
  return (LEGACY_IMPORT_SOURCE_TABLES as readonly string[]).includes(value);
}

/** Whether `(table, id)` is a key a map row may carry. */
export function isLegacyImportKey(legacyTable: string, legacyId: string): boolean {
  return isLegacyImportSourceTable(legacyTable) && LEGACY_ID_PATTERNS[legacyTable].test(legacyId);
}
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
