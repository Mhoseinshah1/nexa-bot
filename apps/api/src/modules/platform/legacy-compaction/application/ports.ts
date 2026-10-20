import type {
  LegacyCompactionFailureCode,
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
}

export interface BatchResult {
  readonly count: number;
  /** The last id the batch scanned; null when nothing was left. */
  readonly last: string | null;
}

export interface LegacyCompactionRepository {
  latest(tenantId: string, tx?: Executor): Promise<LegacyCompactionRow | null>;
  completedExists(tenantId: string, tx?: Executor): Promise<boolean>;
  importReadiness(
    tenantId: string,
    tx?: Executor,
  ): Promise<{ readonly completed: boolean; readonly inFlight: boolean }>;
  create(
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly now: Date;
      readonly adminId: string | null;
      readonly label: string | null;
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
   * (`IMPORT_NOT_READY`) while an import is in flight or none has completed.
   */
  beginArchiving(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<'ADVANCED' | 'IMPORT_NOT_READY' | 'LEASE_LOST'>;
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
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult>;
  dedupBatch(
    tx: Executor,
    input: { readonly tenantId: string; readonly after: string | null; readonly limit: number },
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
  /**
   * Names this run to the archive's guard (migration 0262) for THIS transaction only: the
   * one way an update or delete of a legacy history record is accepted.
   */
  authorise(tx: Executor, runId: string): Promise<void>;
  measure(tenantId: string): Promise<CompactionSizes>;
  vacuum(): Promise<void>;
}
