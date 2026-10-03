import {
  LEGACY_CODE_VERSION_PATTERN,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_SHA256_PATTERN,
  errors,
  isLegacyImportKey,
  isLegacyImportSourceTable,
  type LegacyImportEntityType,
  type LegacyImportMapStatus,
  type LegacyImportReasonCode,
  type LegacyImportRunFailureCode,
  type LegacyImportRunMode,
  type LegacyImportRunStatus,
  type TenantContext,
} from '@nexa/contracts';

/**
 * Migration P4 — the port over `legacy_import_runs` / `legacy_import_map`
 * (`docs/legacy-import-metadata.md`).
 *
 * This is metadata the P7 importer (on HOLD) will write inside ITS OWN business
 * transactions; every write method therefore takes the caller's transaction handle. The
 * importer service — not this port — owns the permission check, the
 * `ScopeActivityReader` read and the audit row, exactly as every other write path does.
 * What this port owns is the part that must be true whoever calls it:
 *
 * - one row per legacy key, decided by `(tenant_id, legacy_table, legacy_id)`;
 * - a map write happens only under a RUNNING `APPLY` run of the SAME tenant, checked in the
 *   statement, with the run row share-locked so a concurrent finish cannot snapshot
 *   counters that exclude it;
 * - an `IMPORTED` row is never re-pointed, downgraded or silently re-checksummed;
 * - every run transition is a conditional UPDATE naming `RUNNING`.
 */

export interface LegacyImportRunRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly mode: LegacyImportRunMode;
  readonly status: LegacyImportRunStatus;
  readonly sourceFingerprint: string;
  readonly codeVersion: string | null;
  readonly failureCode: LegacyImportRunFailureCode | null;
  readonly rowsSeen: number;
  readonly rowsImported: number;
  readonly rowsSkipped: number;
  readonly rowsManualReview: number;
  readonly rowsFailed: number;
  readonly startedAt: Date;
  readonly lastProgressAt: Date;
  readonly finishedAt: Date | null;
}

export interface LegacyImportMapRecord {
  readonly tenantId: string;
  readonly legacyTable: string;
  readonly legacyId: string;
  readonly runId: string;
  readonly checksum: string;
  readonly status: LegacyImportMapStatus;
  readonly reasonCode: LegacyImportReasonCode | null;
  readonly entityType: LegacyImportEntityType | null;
  readonly entityId: string | null;
  readonly attempts: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** One decision about one legacy record, as the importer hands it over. */
export type LegacyImportDecision =
  | {
      readonly status: 'IMPORTED';
      readonly entityType: LegacyImportEntityType;
      readonly entityId: string;
      /** An optional warning, e.g. `EXISTING_CUSTOMER`. */
      readonly reasonCode: LegacyImportReasonCode | null;
    }
  | {
      readonly status: Exclude<LegacyImportMapStatus, 'IMPORTED'>;
      readonly reasonCode: LegacyImportReasonCode;
    };

export interface LegacyImportMapWrite {
  readonly runId: string;
  readonly legacyTable: string;
  readonly legacyId: string;
  readonly checksum: string;
  readonly decision: LegacyImportDecision;
  readonly now: Date;
}

export type LegacyImportMapWriteOutcome =
  | { readonly kind: 'INSERTED'; readonly record: LegacyImportMapRecord }
  | { readonly kind: 'UPDATED'; readonly record: LegacyImportMapRecord }
  | { readonly kind: 'UNCHANGED'; readonly record: LegacyImportMapRecord }
  | {
      readonly kind: 'REFUSED';
      /**
       * - `IMPORTED_ENTITY_MISMATCH` — the row is IMPORTED as a different entity, or the new
       *   decision would downgrade it. Provenance is not rewritten by a rerun.
       * - `IMPORTED_SOURCE_CHANGED` — IMPORTED from a source row whose checksum differs now.
       *   The drift is surfaced, never absorbed by overwriting the checksum.
       */
      readonly reason: 'IMPORTED_ENTITY_MISMATCH' | 'IMPORTED_SOURCE_CHANGED';
      readonly record: LegacyImportMapRecord;
    };

export type LegacyImportStartOutcome =
  | { readonly kind: 'STARTED'; readonly run: LegacyImportRunRecord }
  | { readonly kind: 'RESUMED'; readonly run: LegacyImportRunRecord };

export interface LegacyImportSummaryRow {
  readonly legacyTable: string;
  readonly status: LegacyImportMapStatus;
  readonly reasonCode: LegacyImportReasonCode | null;
  readonly count: number;
}

export interface LegacyImportReviewCursor {
  readonly legacyTable: string;
  readonly legacyId: string;
}

export interface LegacyImportReviewPage {
  readonly items: readonly LegacyImportMapRecord[];
  readonly next: LegacyImportReviewCursor | null;
}

export interface LegacyImportRepository {
  /**
   * Starts a run, or resumes the tenant's RUNNING `APPLY` run when it has the same source
   * fingerprint. A RUNNING `DRY_RUN` is never resumed — its counters would count the
   * re-processed rows twice — and is refused (`RUN_CONFLICT`, with its id) like any other
   * running run; the caller aborts it and starts again. A RUNNING run with a different source or mode is refused
   * (`RUN_CONFLICT`): two imports of two snapshots interleaved would make every map row's
   * checksum a coin toss.
   */
  startOrResume(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly mode: LegacyImportRunMode;
      readonly sourceFingerprint: string;
      readonly codeVersion: string | null;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LegacyImportStartOutcome>;

  findRun(scope: TenantContext, runId: string, tx?: unknown): Promise<LegacyImportRunRecord | null>;

  /** Advances `rows_seen` monotonically and stamps progress. Only while RUNNING. */
  checkpoint(
    scope: TenantContext,
    runId: string,
    rowsSeen: number,
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord>;

  /**
   * A `DRY_RUN`'s decision: increments the run's counter for `status`, by a conditional
   * UPDATE naming `RUNNING` and `DRY_RUN`. Refused (`RUN_NOT_WRITABLE`) for an `APPLY`
   * run, whose counters come from its map rows, and for a finished one.
   */
  recordDryRunDecision(
    scope: TenantContext,
    runId: string,
    status: LegacyImportMapStatus,
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord>;

  /**
   * RUNNING → a terminal status. An `APPLY` run's counters are snapshotted from the map
   * rows it wrote (the authoritative record); a `DRY_RUN` keeps the counters its decisions
   * incremented. `finished_at` is clamped to `GREATEST(started_at, last_progress_at, now)`
   * so a skewed clock cannot finish a run before its own recorded progress. Refuses
   * (`RUN_NOT_WRITABLE`) from any other status.
   */
  finish(
    scope: TenantContext,
    runId: string,
    outcome:
      | { readonly status: 'COMPLETED' | 'ABORTED' }
      | { readonly status: 'FAILED'; readonly failureCode: LegacyImportRunFailureCode },
    now: Date,
    tx: unknown,
  ): Promise<LegacyImportRunRecord>;

  /** The idempotent upsert by legacy key. See `decideMapWrite`. */
  recordDecision(
    scope: TenantContext,
    write: LegacyImportMapWrite,
    tx: unknown,
  ): Promise<LegacyImportMapWriteOutcome>;

  /** The rows already decided for these legacy keys — what a resume asks first. */
  findByLegacyKeys(
    scope: TenantContext,
    legacyTable: string,
    legacyIds: readonly string[],
    tx?: unknown,
  ): Promise<readonly LegacyImportMapRecord[]>;

  /** Counts by table, status and reason: the reconcile view. */
  summarize(scope: TenantContext, tx?: unknown): Promise<readonly LegacyImportSummaryRow[]>;

  /** MANUAL_REVIEW rows, keyset-paged by `(legacy_table, legacy_id)`. */
  listManualReview(
    scope: TenantContext,
    query: {
      readonly legacyTable?: string;
      readonly reasonCode?: LegacyImportReasonCode;
      readonly after?: LegacyImportReviewCursor;
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<LegacyImportReviewPage>;
}

export const LEGACY_IMPORT_REVIEW_PAGE_MAX = 500;

// --- pure rules ----------------------------------------------------------------------------

/**
 * What a write does to an existing row. The one rule, kept pure so a unit test pins every
 * branch and the repository cannot grow a second opinion.
 */
export function decideMapWrite(
  existing: Pick<
    LegacyImportMapRecord,
    'status' | 'checksum' | 'entityType' | 'entityId' | 'reasonCode'
  >,
  incoming: { readonly checksum: string; readonly decision: LegacyImportDecision },
): 'UNCHANGED' | 'UPDATE' | 'IMPORTED_ENTITY_MISMATCH' | 'IMPORTED_SOURCE_CHANGED' {
  const d = incoming.decision;
  const incomingEntityType = d.status === 'IMPORTED' ? d.entityType : null;
  const incomingEntityId = d.status === 'IMPORTED' ? d.entityId : null;
  if (existing.status === 'IMPORTED') {
    if (
      d.status !== 'IMPORTED' ||
      existing.entityType !== incomingEntityType ||
      existing.entityId !== incomingEntityId
    ) {
      return 'IMPORTED_ENTITY_MISMATCH';
    }
    if (existing.checksum !== incoming.checksum) return 'IMPORTED_SOURCE_CHANGED';
    return existing.reasonCode === d.reasonCode ? 'UNCHANGED' : 'UPDATE';
  }
  if (
    existing.status === d.status &&
    existing.checksum === incoming.checksum &&
    existing.reasonCode === d.reasonCode &&
    existing.entityType === incomingEntityType &&
    existing.entityId === incomingEntityId
  ) {
    return 'UNCHANGED';
  }
  return 'UPDATE';
}

/**
 * What a resumed or repeated run does with one source row, given what the map already says.
 *
 * - `SKIP` — IMPORTED from this exact source row; doing it again would duplicate it.
 * - `SOURCE_CHANGED` — IMPORTED, but the source row differs now: a human decides.
 * - `PROCESS` — never decided, or decided as something a rerun is allowed to revisit.
 */
export function resumeDecision(
  existing: Pick<LegacyImportMapRecord, 'status' | 'checksum'> | null,
  checksum: string,
): 'SKIP' | 'SOURCE_CHANGED' | 'PROCESS' {
  if (existing === null || existing.status !== 'IMPORTED') return 'PROCESS';
  return existing.checksum === checksum ? 'SKIP' : 'SOURCE_CHANGED';
}

function invalid(message: string): never {
  throw errors.validation(LEGACY_IMPORT_ERROR_CODES.INVALID, message);
}

/** Shape checks before SQL, so a refusal is a typed error rather than a CHECK violation. */
export function assertLegacyKey(legacyTable: string, legacyId: string): void {
  if (!isLegacyImportSourceTable(legacyTable)) invalid('legacy table is not an importable source');
  if (!isLegacyImportKey(legacyTable, legacyId)) {
    invalid('legacy id is not the evidenced key shape for its table');
  }
}

export function assertSha256(value: string, what: string): void {
  if (!LEGACY_SHA256_PATTERN.test(value)) invalid(`${what} is not a lowercase SHA-256 hex`);
}

export function assertCodeVersion(value: string | null): void {
  if (value !== null && !LEGACY_CODE_VERSION_PATTERN.test(value)) {
    invalid('code version is not a bounded version string');
  }
}
