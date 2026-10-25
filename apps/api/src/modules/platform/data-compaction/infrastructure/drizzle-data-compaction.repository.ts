import { sql, type SQL } from 'drizzle-orm';
import {
  DATA_COMPACTION_CLASSES,
  type DataCompactionMode,
  type DataCompactionRunState,
  type DataCompactionStopReason,
  type DataCompactionTable,
  type DataCompactionTrigger,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import {
  assertCompactable,
  CUSTOMER_NOTIFICATION_COMPACTABLE_STATES,
  customerKindsCompacted,
} from '../application/allow-list.js';
import type {
  BatchResult,
  ClassCutoffs,
  CompactionStep,
  DataCompactionRepository,
  DataCompactionRunRow,
  TableCounts,
} from '../application/ports.js';

/**
 * The data compaction's SQL (Round 9 C3).
 *
 * ONE predicate per step, used by BOTH the dry run's count and the batch's delete, so what a
 * dry run reports is exactly what an applied pass removes at the same cutoff. Every predicate is
 * half-open in time: a row is eligible when its stamp is STRICTLY before the cutoff, so a row
 * stamped exactly at it stays.
 *
 * Every DELETE goes through `deleteRows`, which refuses a table outside the allow-list
 * (`assertCompactable`). A batch selects at most `limit` parent ids after the keyset cursor,
 * `FOR UPDATE SKIP LOCKED`, then removes their children and the parents in the same
 * transaction, re-stating the parent predicate in the DELETE so a row that changed between the
 * select and the delete stays.
 */

const NOTIFICATION_FINISHED = sql`('SENT', 'FAILED')`;

function stepPredicate(step: CompactionStep, tenantId: string, cutoff: Date): SQL {
  switch (step) {
    case 'OPS_NOTIFICATIONS':
      return sql`x.tenant_id = ${tenantId}::uuid
        AND x.status IN ${NOTIFICATION_FINISHED}
        AND x.completed_at < ${cutoff}`;
    case 'CUSTOMER_NOTIFICATIONS':
      return sql`x.tenant_id = ${tenantId}::uuid
        AND x.state = ANY(${sql.param([...CUSTOMER_NOTIFICATION_COMPACTABLE_STATES])}::text[])
        AND x.resolved_at < ${cutoff}
        AND (x.kind = ANY(${sql.param(customerKindsCompacted('RESOLVED'))}::text[])
             OR (x.kind = ANY(${sql.param(customerKindsCompacted('ANNOUNCED'))}::text[])
                 AND EXISTS (
                   SELECT 1 FROM provisioning_operations op
                    WHERE op.tenant_id = x.tenant_id AND op.id = x.subject_id
                      AND op.announced_at IS NOT NULL)))`;
    case 'RECEIPT_CAPTURES':
      return sql`x.tenant_id = ${tenantId}::uuid
        AND x.closed_at IS NOT NULL
        AND x.closed_at < ${cutoff}`;
    case 'GATEWAY_RECEIPT_CAPTURES':
      return sql`x.tenant_id = ${tenantId}::uuid
        AND x.closed_at IS NOT NULL
        AND x.closed_at < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM gateway_receipt_submissions s
           WHERE s.tenant_id = x.tenant_id AND s.capture_id = x.id)`;
  }
}

/** The parent table each step walks. */
const STEP_PARENT: Readonly<Record<CompactionStep, DataCompactionTable>> = {
  OPS_NOTIFICATIONS: 'notifications',
  CUSTOMER_NOTIFICATIONS: 'customer_notifications',
  RECEIPT_CAPTURES: 'receipt_captures',
  GATEWAY_RECEIPT_CAPTURES: 'gateway_receipt_captures',
};

/** Children removed with their parent, keyed `(tenant_id, notification_id)`. */
const OPS_CHILDREN: readonly DataCompactionTable[] = [
  'notification_released_claims',
  'notification_delivery_attempts',
];

type RunRaw = {
  id: string;
  tenant_id: string;
  trigger: string;
  mode: string;
  state: string;
  started_at: Date | string;
  heartbeat_at: Date | string;
  finished_at: Date | string | null;
  cutoffs: Record<string, string>;
  counts: Record<string, number>;
  stop_reason: string | null;
};

function toRun(raw: RunRaw): DataCompactionRunRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    trigger: raw.trigger as DataCompactionTrigger,
    mode: raw.mode as DataCompactionMode,
    state: raw.state as DataCompactionRunState,
    startedAt: new Date(raw.started_at),
    heartbeatAt: new Date(raw.heartbeat_at),
    finishedAt: raw.finished_at === null ? null : new Date(raw.finished_at),
    cutoffs: raw.cutoffs,
    counts: raw.counts as TableCounts,
    stopReason: raw.stop_reason as DataCompactionStopReason | null,
  };
}

function nonZero(counts: Record<string, number>): TableCounts {
  const out: Record<string, number> = {};
  for (const [table, n] of Object.entries(counts)) if (n > 0) out[table] = n;
  return out as TableCounts;
}

export class DrizzleDataCompactionRepository implements DataCompactionRepository {
  constructor(private readonly db: Database) {}

  async count(
    tx: Executor,
    tenantId: string,
    step: CompactionStep,
    cutoff: Date,
  ): Promise<TableCounts> {
    const parent = STEP_PARENT[step];
    const where = stepPredicate(step, tenantId, cutoff);
    if (step === 'OPS_NOTIFICATIONS') {
      const result = await tx.execute<{ parents: string; attempts: string; claims: string }>(sql`
        SELECT
          (SELECT count(*) FROM notifications x WHERE ${where})::text AS parents,
          (SELECT count(*) FROM notification_delivery_attempts a
             JOIN notifications x ON x.tenant_id = a.tenant_id AND x.id = a.notification_id
            WHERE ${where})::text AS attempts,
          (SELECT count(*) FROM notification_released_claims r
             JOIN notifications x ON x.tenant_id = r.tenant_id AND x.id = r.notification_id
            WHERE ${where})::text AS claims`);
      const row = result.rows[0];
      return nonZero({
        notifications: Number(row?.parents ?? 0),
        notification_delivery_attempts: Number(row?.attempts ?? 0),
        notification_released_claims: Number(row?.claims ?? 0),
      });
    }
    const result = await tx.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.identifier(parent)} x WHERE ${where}`,
    );
    return nonZero({ [parent]: Number(result.rows[0]?.n ?? 0) });
  }

  async deleteBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly step: CompactionStep;
      readonly cutoff: Date;
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<BatchResult> {
    const parent = STEP_PARENT[input.step];
    assertCompactable(parent);
    const where = stepPredicate(input.step, input.tenantId, input.cutoff);
    const after = input.after === null ? sql`` : sql`AND x.id > ${input.after}::uuid`;
    const picked = await tx.execute<{ id: string }>(sql`
      SELECT x.id FROM ${sql.identifier(parent)} x
       WHERE ${where} ${after}
       ORDER BY x.id
       LIMIT ${input.limit}
       FOR UPDATE OF x SKIP LOCKED`);
    const ids = picked.rows.map((row) => row.id);
    if (ids.length === 0) return { counts: {}, parents: 0, last: null };

    const counts: Record<string, number> = {};
    const idList = sql`${sql.param(ids)}::uuid[]`;
    if (input.step === 'OPS_NOTIFICATIONS') {
      for (const child of OPS_CHILDREN) {
        counts[child] = await this.deleteRows(
          tx,
          child,
          sql`t.tenant_id = ${input.tenantId}::uuid AND t.notification_id = ANY(${idList})`,
        );
      }
    }
    // The predicate again, in the DELETE: a row that changed since the select is not removed.
    const removed = await this.deleteRows(
      tx,
      parent,
      sql`t.id = ANY(${idList}) AND EXISTS (
            SELECT 1 FROM ${sql.identifier(parent)} x WHERE x.id = t.id AND ${where})`,
    );
    counts[parent] = removed;
    const last = ids.reduce((max, id) => (id > max ? id : max), ids[0] ?? '');
    return { counts: nonZero(counts), parents: ids.length, last };
  }

  /** THE one DELETE in this file, behind the allow-list. */
  private async deleteRows(tx: Executor, table: string, where: SQL): Promise<number> {
    assertCompactable(table);
    const result = await tx.execute(sql`DELETE FROM ${sql.identifier(table)} AS t WHERE ${where}`);
    return result.rowCount ?? 0;
  }

  async authorise(tx: Executor, runId: string): Promise<void> {
    // `true`: transaction-local, gone at COMMIT or ROLLBACK (0279's guard reads it).
    await tx.execute(sql`SELECT set_config('nexa.data_compaction_run', ${runId}, true)`);
  }

  async start(
    tx: Executor,
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly trigger: DataCompactionTrigger;
      readonly mode: DataCompactionMode;
      readonly now: Date;
      readonly cutoffs: ClassCutoffs;
    },
  ): Promise<boolean> {
    const cutoffs: Record<string, string> = {};
    for (const cls of DATA_COMPACTION_CLASSES) cutoffs[cls] = input.cutoffs[cls].toISOString();
    // A savepoint, so losing the one-RUNNING race leaves the caller's transaction usable.
    try {
      await tx.transaction(async (nested) => {
        await nested.execute(sql`
          INSERT INTO data_compaction_runs
            (id, tenant_id, trigger, mode, state, started_at, heartbeat_at, cutoffs, counts)
          VALUES (${input.id}::uuid, ${input.tenantId}::uuid, ${input.trigger}, ${input.mode},
                  'RUNNING', ${input.now}, ${input.now}, ${JSON.stringify(cutoffs)}::jsonb,
                  '{}'::jsonb)`);
      });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async advance(
    tx: Executor,
    input: { readonly id: string; readonly add: TableCounts; readonly now: Date },
  ): Promise<boolean> {
    // Each table's figure is added inside the batch's own transaction: commits with its rows.
    let counts = sql`counts`;
    for (const [table, n] of Object.entries(input.add)) {
      if (n === undefined || n === 0) continue;
      counts = sql`jsonb_set(${counts}, ARRAY[${table}]::text[],
        to_jsonb(COALESCE((counts ->> ${table})::bigint, 0) + ${n}::bigint))`;
    }
    const result = await tx.execute(sql`
      UPDATE data_compaction_runs
         SET counts = ${counts}, heartbeat_at = ${input.now}
       WHERE id = ${input.id}::uuid AND state = 'RUNNING'`);
    return (result.rowCount ?? 0) === 1;
  }

  async finish(
    tx: Executor,
    input: {
      readonly id: string;
      readonly to: Exclude<DataCompactionRunState, 'RUNNING'>;
      readonly reason: DataCompactionStopReason | null;
      readonly now: Date;
    },
  ): Promise<boolean> {
    const result = await tx.execute(sql`
      UPDATE data_compaction_runs
         SET state = ${input.to}, stop_reason = ${input.reason},
             finished_at = ${input.now}, heartbeat_at = ${input.now}
       WHERE id = ${input.id}::uuid AND state = 'RUNNING'`);
    return (result.rowCount ?? 0) === 1;
  }

  async failAbandoned(
    tx: Executor,
    tenantId: string,
    staleBefore: Date,
    now: Date,
  ): Promise<number> {
    const result = await tx.execute(sql`
      UPDATE data_compaction_runs
         SET state = 'FAILED', stop_reason = 'ABANDONED', finished_at = ${now}
       WHERE tenant_id = ${tenantId}::uuid AND state = 'RUNNING'
         AND heartbeat_at < ${staleBefore}`);
    return result.rowCount ?? 0;
  }

  async latest(
    tenantId: string,
    filter: { readonly trigger?: DataCompactionTrigger } = {},
  ): Promise<DataCompactionRunRow | null> {
    const trigger = filter.trigger === undefined ? sql`` : sql`AND trigger = ${filter.trigger}`;
    const result = await this.db.execute<RunRaw>(sql`
      SELECT id, tenant_id, trigger, mode, state, started_at, heartbeat_at, finished_at,
             cutoffs, counts, stop_reason
        FROM data_compaction_runs
       WHERE tenant_id = ${tenantId}::uuid ${trigger}
       ORDER BY started_at DESC, id DESC
       LIMIT 1`);
    const row = result.rows[0];
    return row === undefined ? null : toRun(row);
  }
}
