import {
  LEGACY_CODE_VERSION_PATTERN,
  LEGACY_IMPORT_ERROR_CODES,
  LEGACY_SHA256_PATTERN,
  errors,
  isLegacyImportKey,
  isLegacyImportSourceTable,
  LEGACY_REVIEW_RETRY_RESOLUTIONS,
  type ActorType,
  type LegacyImportEntityType,
  type LegacyImportMapStatus,
  type LegacyImportReasonCode,
  type LegacyImportRunFailureCode,
  type LegacyImportRunMode,
  type LegacyImportRunStatus,
  type LegacyReviewReasonCode,
  type LegacyReviewResolutionCode,
  type LegacyReviewState,
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
  /** Item 9: non-null exactly when `status` is `MANUAL_REVIEW`. */
  readonly reviewState: LegacyReviewState | null;
  /** Item 9: set only while the review is RESOLVED or DISMISSED. */
  readonly reviewResolutionCode: LegacyReviewResolutionCode | null;
  readonly reviewedAt: Date | null;
  readonly reviewedByActorType: ActorType | null;
  readonly reviewedByActorId: string | null;
  readonly reviewReopenedCount: number;
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
      /**
       * - `REVIEW_CLOSED` (Item 9) — the row is a MANUAL_REVIEW a person closed with a
       *   resolution that does not invite a rerun (`HANDLED_OUTSIDE_IMPORT`, or DISMISSED).
       *   A rerun never silently overwrites a person's decision; they reopen it first.
       */
      readonly reason: 'IMPORTED_ENTITY_MISMATCH' | 'IMPORTED_SOURCE_CHANGED' | 'REVIEW_CLOSED';
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

/** Item 9: one bucket of the review queue's counts. */
export interface LegacyReviewCountRow {
  readonly legacyTable: string;
  readonly reasonCode: LegacyReviewReasonCode;
  readonly reviewState: LegacyReviewState;
  readonly count: number;
}

/** Who closed a review: the actor's type and stable id, as `audit_logs` names them. */
export interface LegacyReviewActorRef {
  readonly type: ActorType;
  readonly id: string;
}

/**
 * Item 9: what a review transition did. The repository never throws for a row that is
 * merely in another state; the service decides what that means to its caller.
 *
 * - `CHANGED` — this call moved the row (`from` is the state it left).
 * - `UNCHANGED` — the row was already exactly where this call would put it (a replay, a
 *   double-click, a racing identical request).
 * - `NOT_FOUND` — no row for this key in this tenant.
 * - `NOT_IN_REVIEW` — the row exists and is not `MANUAL_REVIEW`.
 * - `CONFLICT` — the row is in review but not in a state this call may move it from (closed
 *   with another resolution; or its reason is no longer the one the caller saw).
 */
export type LegacyReviewTransitionOutcome =
  | {
      readonly kind: 'CHANGED';
      readonly from: LegacyReviewState;
      readonly record: LegacyImportMapRecord;
    }
  | { readonly kind: 'UNCHANGED'; readonly record: LegacyImportMapRecord }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'NOT_IN_REVIEW'; readonly record: LegacyImportMapRecord }
  | { readonly kind: 'CONFLICT'; readonly record: LegacyImportMapRecord };

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

  /**
   * MANUAL_REVIEW rows, keyset-paged by `(legacy_table, legacy_id)`. Item 9 adds the review
   * state and the run (the run that last wrote the row) as filters.
   */
  listManualReview(
    scope: TenantContext,
    query: {
      readonly legacyTable?: string;
      readonly reasonCode?: LegacyImportReasonCode;
      readonly reviewState?: LegacyReviewState;
      readonly runId?: string;
      readonly after?: LegacyImportReviewCursor;
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<LegacyImportReviewPage>;

  /**
   * Item 9: MANUAL_REVIEW rows counted by `(legacy_table, reason_code, review_state)` — for
   * the tenant, or only the rows a given run last wrote.
   */
  countReview(
    scope: TenantContext,
    query: { readonly runId?: string },
    tx?: unknown,
  ): Promise<readonly LegacyReviewCountRow[]>;

  /**
   * Item 9: OPEN -> the resolution's closed state, by ONE conditional UPDATE naming
   * `status = 'MANUAL_REVIEW'`, `review_state = 'OPEN'` and the reason the caller saw.
   */
  resolveReview(
    scope: TenantContext,
    input: {
      readonly legacyTable: string;
      readonly legacyId: string;
      readonly expectedReasonCode: LegacyReviewReasonCode;
      readonly resolutionCode: LegacyReviewResolutionCode;
      readonly actor: LegacyReviewActorRef;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<LegacyReviewTransitionOutcome>;

  /**
   * Item 9: RESOLVED | DISMISSED -> OPEN, by ONE conditional UPDATE naming those states;
   * clears the resolution and counts the reopen.
   */
  reopenReview(
    scope: TenantContext,
    input: { readonly legacyTable: string; readonly legacyId: string; readonly now: Date },
    tx: unknown,
  ): Promise<LegacyReviewTransitionOutcome>;
}

export const LEGACY_IMPORT_REVIEW_PAGE_MAX = 500;

// --- pure rules ----------------------------------------------------------------------------

/** The review fields a rule reads; absent means "no review" (a record without Item 9 fields). */
interface ReviewView {
  readonly reviewState?: LegacyReviewState | null;
  readonly reviewResolutionCode?: LegacyReviewResolutionCode | null;
}

/**
 * Item 9: whether a person closed this review in a way a rerun must not act on — DISMISSED,
 * or RESOLVED with anything but a retry resolution. Such a row is refused to every rerun
 * write (`REVIEW_CLOSED`) and skipped by a resume until a person reopens it.
 */
export function isReviewClosedToRerun(existing: { readonly status: string } & ReviewView): boolean {
  if (existing.status !== 'MANUAL_REVIEW') return false;
  const state = existing.reviewState ?? 'OPEN';
  if (state === 'OPEN') return false;
  if (state === 'DISMISSED') return true;
  return !isRetryResolution(existing.reviewResolutionCode ?? null);
}

function isRetryResolution(code: LegacyReviewResolutionCode | null): boolean {
  return code !== null && (LEGACY_REVIEW_RETRY_RESOLUTIONS as readonly string[]).includes(code);
}

/** Item 9: a RESOLVED review whose resolution invites the importer to decide again. */
function isRetryResolved(existing: { readonly status: string } & ReviewView): boolean {
  return (
    existing.status === 'MANUAL_REVIEW' &&
    existing.reviewState === 'RESOLVED' &&
    isRetryResolution(existing.reviewResolutionCode ?? null)
  );
}

/**
 * What a write does to an existing row. The one rule, kept pure so a unit test pins every
 * branch and the repository cannot grow a second opinion.
 *
 * Item 9 adds two branches for a non-IMPORTED row, both before the ordinary comparison:
 * - a review a person closed to reruns is `REVIEW_CLOSED` for any write except an identical
 *   one (which stays `UNCHANGED`, so a replayed run is not an error);
 * - a review RESOLVED with `RETRY_AFTER_FIX` is always `UPDATE`, even for an identical
 *   decision: the retry was asked for, and a decision that comes back the same puts the
 *   row back OPEN in the queue rather than leaving it closed as if fixed.
 */
export function decideMapWrite(
  existing: Pick<
    LegacyImportMapRecord,
    'status' | 'checksum' | 'entityType' | 'entityId' | 'reasonCode'
  > &
    ReviewView,
  incoming: { readonly checksum: string; readonly decision: LegacyImportDecision },
):
  | 'UNCHANGED'
  | 'UPDATE'
  | 'IMPORTED_ENTITY_MISMATCH'
  | 'IMPORTED_SOURCE_CHANGED'
  | 'REVIEW_CLOSED' {
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
  const identical =
    existing.status === d.status &&
    existing.checksum === incoming.checksum &&
    existing.reasonCode === d.reasonCode &&
    existing.entityType === incomingEntityType &&
    existing.entityId === incomingEntityId;
  if (isReviewClosedToRerun(existing)) return identical ? 'UNCHANGED' : 'REVIEW_CLOSED';
  if (isRetryResolved(existing)) return 'UPDATE';
  return identical ? 'UNCHANGED' : 'UPDATE';
}

/**
 * Item 9: the review fields an `UPDATE` verdict writes, from the row before and the decision
 * after. A row that leaves review has no review state (its history is in the audit log); a
 * row that stays in or enters review is OPEN; a review that was closed and comes back OPEN
 * (a retry whose decision is review again) counts one reopen.
 */
export function reviewAfterWrite(
  existing: { readonly status: string } & ReviewView,
  incomingStatus: LegacyImportMapStatus,
): { readonly reviewState: 'OPEN' | null; readonly reopened: boolean } {
  if (incomingStatus !== 'MANUAL_REVIEW') return { reviewState: null, reopened: false };
  const wasClosed =
    existing.status === 'MANUAL_REVIEW' &&
    (existing.reviewState === 'RESOLVED' || existing.reviewState === 'DISMISSED');
  return { reviewState: 'OPEN', reopened: wasClosed };
}

/**
 * What a resumed or repeated run does with one source row, given what the map already says.
 *
 * - `SKIP` — IMPORTED from this exact source row; doing it again would duplicate it.
 * - `SOURCE_CHANGED` — IMPORTED, but the source row differs now: a human decides.
 * - `REVIEW_CLOSED` (Item 9) — a person closed this review to reruns; leave it alone (its
 *   write would be refused anyway, after the work was done).
 * - `PROCESS` — never decided, or decided as something a rerun is allowed to revisit
 *   (FAILED, SKIPPED, an OPEN review, a review RESOLVED with `RETRY_AFTER_FIX`).
 */
export function resumeDecision(
  existing: (Pick<LegacyImportMapRecord, 'status' | 'checksum'> & ReviewView) | null,
  checksum: string,
): 'SKIP' | 'SOURCE_CHANGED' | 'REVIEW_CLOSED' | 'PROCESS' {
  if (existing === null) return 'PROCESS';
  if (isReviewClosedToRerun(existing)) return 'REVIEW_CLOSED';
  if (existing.status !== 'IMPORTED') return 'PROCESS';
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
