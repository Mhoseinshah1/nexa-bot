import type {
  LegacyCleanupClearedTable,
  LegacyCompactionFailureCode,
  LegacyCompactionReason,
  LegacyCompactionState,
  LegacyHistoryRecordType,
} from '@nexa/contracts';
import type { Executor } from '../../../../infrastructure/persistence/database.js';

/** The report's half: total relation size per table (bytes, as text) and rows per type. */
export interface CompactionSizes {
  readonly tables: Readonly<Record<string, string>>;
  readonly recordTypes: Readonly<Partial<Record<string, number>>>;
}

export interface LegacyCompactionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly state: LegacyCompactionState;
  readonly requestedAt: Date;
  readonly requestedByLabel: string | null;
  readonly updatedAt: Date;
  readonly leaseOwner: string | null;
  readonly archiveBackupId: string | null;
  readonly cursor: string | null;
  readonly deleted: bigint;
  readonly deduplicated: bigint;
  readonly stripped: bigint;
  readonly before: CompactionSizes | null;
  readonly after: CompactionSizes | null;
  readonly failureCode: LegacyCompactionFailureCode | null;
  readonly finishedAt: Date | null;
  /** PR-L: `SUPPLEMENTARY` — «پاک‌سازی تکمیلی», a second run after an older rule revision. */
  readonly reason: LegacyCompactionReason;
  /** PR-L: the cleanup rules' revision this run applies (`LEGACY_CLEANUP_REVISION`). */
  readonly revision: number;
  /** PR-L: when its VACUUM FULL was proven; null when never. */
  readonly vacuumedAt: Date | null;
}

/** PR-L: the proof a VACUUM FULL happened — every table it rewrote, by name. */
export interface VacuumProof {
  readonly tables: readonly string[];
}

/**
 * PR-L: a VACUUM FULL that did not happen. PostgreSQL does not raise for a table the
 * connection may not vacuum: it prints `WARNING: permission denied to vacuum "…", skipping
 * it` and reports success. That is how the owner's runs COMPLETED with byte-identical sizes:
 * the worker connects as `nexa_app`, which owns no table. So the vacuum is PROVEN per table
 * (the relation was rewritten: its file node changed) and this is thrown when it was not.
 * `deterministic`: retrying cannot help (refused, not rewritten); otherwise (a lock it could
 * not get) the stage is retried before the run fails.
 */
export class LegacyVacuumFailed extends Error {
  constructor(
    readonly table: string,
    readonly why: 'REFUSED' | 'NOT_REWRITTEN' | 'ERROR',
    readonly deterministic: boolean,
    options?: { readonly cause?: unknown },
  ) {
    super(`the VACUUM FULL of ${table} did not happen (${why})`, options);
    this.name = 'LegacyVacuumFailed';
  }
}

export interface BatchResult {
  readonly count: number;
  /** The last id the batch scanned; null when nothing was left. */
  readonly last: string | null;
}

/** One CLEARING batch: which table it emptied rows of (null: nothing left), and how many. */
export interface ClearBatchResult {
  readonly table: LegacyCleanupClearedTable | null;
  readonly rows: number;
  /** Trial limits of 0 the import had imposed, lifted with their decision rows. */
  readonly overridesLifted: number;
}

export interface LegacyCompactionRepository {
  latest(tenantId: string, tx?: Executor): Promise<LegacyCompactionRow | null>;
  /**
   * A COMPLETED run requested after the tenant's latest finished import — of at least
   * `minRevision` when given (PR-L: the automatic cleanup asks for the current revision).
   */
  completedExists(
    tenantId: string,
    tx?: Executor,
    options?: { readonly minRevision?: number },
  ): Promise<boolean>;
  importReadiness(
    tenantId: string,
    tx?: Executor,
  ): Promise<{
    readonly completed: boolean;
    readonly inFlight: boolean;
    /** v0.9.7: the latest applied import's balance reconciliation is recorded and clean. */
    readonly reconciled: boolean;
  }>;
  /**
   * v0.9.7: the tenants whose latest finished import has not been cleaned up — no active run,
   * no COMPLETED run of `revision` (or later) since it finished, and no FAILED one since
   * `retryFailedBefore` — and that have no import in flight. PR-L: `SUPPLEMENTARY` when a
   * COMPLETED run of an older revision since that import exists, else `INITIAL`.
   */
  automaticCandidates(input: {
    readonly now: Date;
    readonly retryFailedBefore: Date;
    readonly revision: number;
  }): Promise<
    readonly {
      readonly tenantId: string;
      readonly importId: string;
      readonly reason: LegacyCompactionReason;
    }[]
  >;
  /** Whether the «waiting for a backup destination» condition is open for the tenant. */
  awaitingDestinationOpen(tenantId: string): Promise<boolean>;
  create(
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly now: Date;
      readonly adminId: string | null;
      readonly label: string | null;
      readonly reason: LegacyCompactionReason;
      readonly revision: number;
    },
    tx: Executor,
  ): Promise<boolean>;
  claim(input: {
    readonly leaseOwner: string;
    readonly now: Date;
    readonly staleBefore: Date;
  }): Promise<LegacyCompactionRow | null>;
  /**
   * Keeps the lease of a run this owner holds alive during a long stage (the archive
   * backup, VACUUM FULL). False when the lease is no longer this owner's.
   */
  heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<boolean>;
  /**
   * REQUESTED → ARCHIVING, decided under the lock an import's start also takes: refused
   * (`IMPORT_NOT_READY`) while an import is in flight or none has completed, and
   * (`RECONCILIATION_NOT_CLEAN`, v0.9.7) while the finished import's balance reconciliation
   * is missing or names a blocking difference.
   */
  beginArchiving(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<'ADVANCED' | 'IMPORT_NOT_READY' | 'RECONCILIATION_NOT_CLEAN' | 'LEASE_LOST'>;
  advance(
    input: {
      readonly id: string;
      readonly leaseOwner: string;
      readonly from: LegacyCompactionState;
      readonly to: LegacyCompactionState;
      readonly now: Date;
      readonly cursor?: string | null;
      readonly archiveBackupId?: string;
      readonly before?: CompactionSizes;
      readonly after?: CompactionSizes;
      readonly failureCode?: LegacyCompactionFailureCode;
      readonly vacuumedAt?: Date;
      readonly addDeleted?: number;
      readonly addDeduplicated?: number;
      readonly addStripped?: number;
    },
    tx?: Executor,
  ): Promise<boolean>;
  deleteDropBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly types: readonly LegacyHistoryRecordType[];
      /** PR-L: Mirza tables whose raw `archive_row` copies are dropped too. */
      readonly archiveTables: readonly string[];
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult>;
  /**
   * `archive_row` records with a twin for the same source key: an invoice in
   * `legacy_invoice_archive`, or (PR-L) a typed record of `twins`' paired type naming the same
   * provenance table and source primary key. No twin: kept.
   */
  dedupBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly twins: readonly {
        readonly sourceTable: string;
        readonly recordType: LegacyHistoryRecordType;
      }[];
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult>;
  stripBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly keys: readonly string[];
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult>;
  /** v0.9.7: one CLEARING batch (`LEGACY_CLEANUP_CLEARED_TABLES`, in order). */
  clearBatch(
    tx: Executor,
    input: { readonly tenantId: string; readonly limit: number },
  ): Promise<ClearBatchResult>;
  /**
   * Names this run to the archive's guard (migration 0266) for THIS transaction only: the
   * one way an update or delete of a legacy history record is accepted.
   */
  authorise(tx: Executor, runId: string): Promise<void>;
  measure(tenantId: string): Promise<CompactionSizes>;
  /** PR-L: ANALYZE of `legacy_history_records`, as the owner (on the maintenance session). */
  analyze(): Promise<void>;
  /**
   * VACUUM (FULL, ANALYZE) of `legacy_history_records` and every cleared table, PROVEN per
   * table; throws `LegacyVacuumFailed` for one that was not rewritten.
   */
  vacuum(): Promise<VacuumProof>;
}
