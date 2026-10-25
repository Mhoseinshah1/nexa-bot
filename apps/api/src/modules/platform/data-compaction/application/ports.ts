import type {
  DataCompactionClass,
  DataCompactionMode,
  DataCompactionRunState,
  DataCompactionStopReason,
  DataCompactionTable,
  DataCompactionTrigger,
} from '@nexa/contracts';
import type { Executor } from '../../../../infrastructure/persistence/database.js';

/** Rows per table. A table with nothing to report is absent, never a zero placeholder. */
export type TableCounts = Partial<Record<DataCompactionTable, number>>;

export type ClassCutoffs = Readonly<Record<DataCompactionClass, Date>>;

export interface DataCompactionRunRow {
  readonly id: string;
  readonly tenantId: string;
  readonly trigger: DataCompactionTrigger;
  readonly mode: DataCompactionMode;
  readonly state: DataCompactionRunState;
  readonly startedAt: Date;
  readonly heartbeatAt: Date;
  readonly finishedAt: Date | null;
  readonly cutoffs: Readonly<Record<string, string>>;
  readonly counts: TableCounts;
  readonly stopReason: DataCompactionStopReason | null;
}

/**
 * One step of a class: a PARENT table walked in keyset order by id, with any children removed
 * in the same batch. `OPS_NOTIFICATIONS` is one step (notifications, children attempts and
 * released claims); `RECEIPT_WINDOWS` is two (manual, then provider windows).
 */
export type CompactionStep =
  'OPS_NOTIFICATIONS' | 'CUSTOMER_NOTIFICATIONS' | 'RECEIPT_CAPTURES' | 'GATEWAY_RECEIPT_CAPTURES';

export const CLASS_STEPS: Readonly<Record<DataCompactionClass, readonly CompactionStep[]>> = {
  OPS_NOTIFICATIONS: ['OPS_NOTIFICATIONS'],
  CUSTOMER_NOTIFICATIONS: ['CUSTOMER_NOTIFICATIONS'],
  RECEIPT_WINDOWS: ['RECEIPT_CAPTURES', 'GATEWAY_RECEIPT_CAPTURES'],
};

export interface BatchResult {
  /** Rows removed per table in this batch. */
  readonly counts: TableCounts;
  /** Parent rows removed: a batch shorter than the limit is the step's last. */
  readonly parents: number;
  /** The greatest parent id removed, the next batch's cursor; null when nothing was. */
  readonly last: string | null;
}

export interface DataCompactionRepository {
  /** What a step WOULD remove at this cutoff: the same predicate the delete uses. */
  count(tx: Executor, tenantId: string, step: CompactionStep, cutoff: Date): Promise<TableCounts>;
  /** Removes at most `limit` parent rows after `after`, with their children. */
  deleteBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly step: CompactionStep;
      readonly cutoff: Date;
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult>;
  /** Names the APPLY pass this transaction deletes for (0279's guard reads it). */
  authorise(tx: Executor, runId: string): Promise<void>;

  /** Inserts a RUNNING row; false when one is already RUNNING for the tenant. */
  start(
    tx: Executor,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly trigger: DataCompactionTrigger;
      readonly mode: DataCompactionMode;
      readonly now: Date;
      readonly cutoffs: ClassCutoffs;
    },
  ): Promise<boolean>;
  /** Adds to the counts and beats the heartbeat; false when the row is no longer RUNNING. */
  advance(
    tx: Executor,
    input: { readonly id: string; readonly add: TableCounts; readonly now: Date },
  ): Promise<boolean>;
  /** RUNNING → `to`. Conditional on RUNNING; false when it was not. */
  finish(
    tx: Executor,
    input: {
      readonly id: string;
      readonly to: Exclude<DataCompactionRunState, 'RUNNING'>;
      readonly reason: DataCompactionStopReason | null;
      readonly now: Date;
    },
  ): Promise<boolean>;
  /** FAILS (ABANDONED) a RUNNING row of the tenant whose heartbeat is older than `staleBefore`. */
  failAbandoned(tx: Executor, tenantId: string, staleBefore: Date, now: Date): Promise<number>;
  latest(
    tenantId: string,
    filter?: { readonly trigger?: DataCompactionTrigger },
  ): Promise<DataCompactionRunRow | null>;
}

/** Whether something else holds the installation: a recovery, or a backup being taken. */
export type InFlightProbe = () => Promise<DataCompactionStopReason | null>;
