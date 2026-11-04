import { sql, type SQL } from 'drizzle-orm';
import type {
  LegacyCleanupClearedTable,
  LegacyCompactionFailureCode,
  LegacyCompactionState,
  LegacyHistoryRecordType,
} from '@nexa/contracts';
import {
  LEGACY_CLEANUP_AWAITING_DESTINATION_CODE,
  LEGACY_CLEANUP_CLEARED_TABLES,
  LEGACY_COMPACTION_ACTIVE_STATES,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import { lockLegacyImportExclusion } from '../../../../infrastructure/persistence/legacy-import-exclusion.js';
import type {
  ClearBatchResult,
  CompactionSizes,
  LegacyCompactionRepository,
  LegacyCompactionRow,
} from '../application/ports.js';
import { balanceReconciliationClean } from '../application/cleanup-rules.js';

/**
 * The compaction's SQL (Round 4 PR-E, E1). Every state change is a conditional UPDATE
 * naming its `from` state and the lease holder; every destructive statement is one batch of
 * at most `limit` rows after a keyset cursor, so none holds a long lock and a restart
 * resumes after the last committed batch.
 */

/** The tables whose size the report shows, before and after. */
const MEASURED_TABLES = [
  'legacy_history_records',
  'legacy_invoice_archive',
  'legacy_invoice_archive_staging',
  'legacy_service_candidates',
  'legacy_import_map',
  'legacy_trial_eligibility',
  'wallet_history_imports',
  'audit_logs',
  'outbox_messages',
  'request_idempotency',
] as const;

/** Imports in these states are finished; any other state is an import in flight. */
const IMPORT_DONE = ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY', 'ADOPT_DONE'];
/** The finished imports that carry an apply report (an adopt lane row carries none). */
const IMPORT_APPLIED = ['COMPLETED', 'COMPLETED_WITH_DISCREPANCY'];
const IMPORT_TERMINAL = [...IMPORT_DONE, 'FAILED', 'CANCELLED', 'VERIFY_FAILED', 'DRY_RUN_FAILED'];

type Raw = {
  id: string;
  tenant_id: string;
  state: string;
  requested_at: Date | string;
  requested_by_label: string | null;
  updated_at: Date | string;
  lease_owner: string | null;
  archive_backup_id: string | null;
  cursor: string | null;
  deleted: string | number;
  deduplicated: string | number;
  stripped: string | number;
  before: CompactionSizes | null;
  after: CompactionSizes | null;
  failure_code: string | null;
  finished_at: Date | string | null;
};

const date = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

function toRow(raw: Raw): LegacyCompactionRow {
  return {
    id: raw.id,
    tenantId: raw.tenant_id,
    state: raw.state as LegacyCompactionState,
    requestedAt: date(raw.requested_at),
    requestedByLabel: raw.requested_by_label,
    updatedAt: date(raw.updated_at),
    leaseOwner: raw.lease_owner,
    archiveBackupId: raw.archive_backup_id,
    cursor: raw.cursor,
    deleted: BigInt(raw.deleted),
    deduplicated: BigInt(raw.deduplicated),
    stripped: BigInt(raw.stripped),
    before: raw.before,
    after: raw.after,
    failureCode: raw.failure_code as LegacyCompactionFailureCode | null,
    finishedAt: raw.finished_at === null ? null : date(raw.finished_at),
  };
}

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

export class DrizzleLegacyCompactionRepository implements LegacyCompactionRepository {
  constructor(private readonly db: Database) {}

  async latest(tenantId: string, tx?: Executor): Promise<LegacyCompactionRow | null> {
    const rows = await (tx ?? this.db).execute<Raw>(sql`
      SELECT * FROM legacy_compaction_runs WHERE tenant_id = ${tenantId}::uuid
       ORDER BY requested_at DESC, id DESC LIMIT 1`);
    const row = rows.rows[0];
    return row === undefined ? null : toRow(row);
  }

  /**
   * A COMPLETED run requested after the tenant's latest finished import: that import's data
   * is already cleaned up. A later import (v0.9.7: a fresh package after a cleanup) is cleaned
   * up again; the earlier run does not count for it.
   */
  async completedExists(tenantId: string, tx?: Executor): Promise<boolean> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT 1 FROM legacy_compaction_runs run
       WHERE run.tenant_id = ${tenantId}::uuid AND run.state = 'COMPLETED'
         AND run.requested_at >= coalesce((
               SELECT max(i.finished_at) FROM legacy_nxpkg_imports i
                WHERE i.tenant_id = ${tenantId}::uuid
                  AND i.status = ANY(${textArray(IMPORT_DONE)})), '-infinity'::timestamptz)
       LIMIT 1`);
    return rows.rows.length > 0;
  }

  async importReadiness(
    tenantId: string,
    tx?: Executor,
  ): Promise<{
    readonly completed: boolean;
    readonly inFlight: boolean;
    readonly reconciled: boolean;
  }> {
    const rows = await (tx ?? this.db).execute<{
      completed: boolean;
      in_flight: boolean;
      reconciliation: unknown;
    }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM legacy_nxpkg_imports
                 WHERE tenant_id = ${tenantId}::uuid AND status = ANY(${textArray(IMPORT_DONE)})) AS completed,
        EXISTS (SELECT 1 FROM legacy_nxpkg_imports
                 WHERE tenant_id = ${tenantId}::uuid
                   AND NOT (status = ANY(${textArray(IMPORT_TERMINAL)}))) AS in_flight,
        -- The latest APPLIED import's recorded balance reconciliation (an adopt lane row has
        -- no apply report: the import it followed decides).
        (SELECT apply_report->'balanceReconciliation' FROM legacy_nxpkg_imports
          WHERE tenant_id = ${tenantId}::uuid AND status = ANY(${textArray(IMPORT_APPLIED)})
          ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1) AS reconciliation`);
    const row = rows.rows[0];
    return {
      completed: row?.completed === true,
      inFlight: row?.in_flight === true,
      reconciled: balanceReconciliationClean(row?.reconciliation ?? null),
    };
  }

  async automaticCandidates(input: {
    readonly now: Date;
    readonly retryFailedBefore: Date;
  }): Promise<readonly { readonly tenantId: string; readonly importId: string }[]> {
    // Per tenant, its latest finished import; a candidate when no import is in flight, no run
    // is active, none COMPLETED since that import finished, and none FAILED since it finished
    // within the last day (a failure is retried daily, never in a loop).
    const rows = await this.db.execute<{ tenant_id: string; id: string }>(sql`
      WITH done AS (
        SELECT DISTINCT ON (tenant_id) tenant_id, id, finished_at FROM legacy_nxpkg_imports
         WHERE status = ANY(${textArray(IMPORT_DONE)})
         ORDER BY tenant_id, finished_at DESC NULLS LAST, id DESC)
      SELECT done.tenant_id, done.id FROM done
       WHERE NOT EXISTS (
               SELECT 1 FROM legacy_nxpkg_imports busy
                WHERE busy.tenant_id = done.tenant_id
                  AND NOT (busy.status = ANY(${textArray(IMPORT_TERMINAL)})))
         AND NOT EXISTS (
               SELECT 1 FROM legacy_compaction_runs active
                WHERE active.tenant_id = done.tenant_id
                  AND active.state = ANY(${textArray(LEGACY_COMPACTION_ACTIVE_STATES)}))
         AND NOT EXISTS (
               SELECT 1 FROM legacy_compaction_runs completed
                WHERE completed.tenant_id = done.tenant_id AND completed.state = 'COMPLETED'
                  AND completed.requested_at >= done.finished_at)
         AND NOT EXISTS (
               SELECT 1 FROM legacy_compaction_runs failed
                WHERE failed.tenant_id = done.tenant_id AND failed.state = 'FAILED'
                  AND failed.requested_at >= done.finished_at
                  AND failed.requested_at > ${input.retryFailedBefore})
       ORDER BY done.tenant_id`);
    return rows.rows.map((row) => ({ tenantId: row.tenant_id, importId: row.id }));
  }

  async awaitingDestinationOpen(tenantId: string): Promise<boolean> {
    const rows = await this.db.execute(sql`
      SELECT 1 FROM operational_events
       WHERE tenant_id = ${tenantId}::uuid AND code = ${LEGACY_CLEANUP_AWAITING_DESTINATION_CODE}
         AND resolved_at IS NULL
       LIMIT 1`);
    return rows.rows.length > 0;
  }

  async create(
    input: {
      readonly id: string;
      readonly tenantId: string;
      readonly now: Date;
      readonly adminId: string | null;
      readonly label: string | null;
    },
    tx: Executor,
  ): Promise<boolean> {
    try {
      await tx.execute(sql`
        INSERT INTO legacy_compaction_runs
          (id, tenant_id, state, requested_at, requested_by_admin_id, requested_by_label, updated_at)
        VALUES (${input.id}::uuid, ${input.tenantId}::uuid, 'REQUESTED', ${input.now},
                ${input.adminId}::uuid, ${input.label}, ${input.now})`);
      return true;
    } catch (error) {
      // The one-active index: another run is in flight.
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  async claim(input: {
    readonly leaseOwner: string;
    readonly now: Date;
    readonly staleBefore: Date;
  }): Promise<LegacyCompactionRow | null> {
    const rows = await this.db.execute<Raw>(sql`
      UPDATE legacy_compaction_runs SET lease_owner = ${input.leaseOwner},
             lease_heartbeat_at = ${input.now}
       WHERE id = (
         SELECT id FROM legacy_compaction_runs
          WHERE state = ANY(${textArray(LEGACY_COMPACTION_ACTIVE_STATES)})
            AND (lease_owner IS NULL OR lease_owner = ${input.leaseOwner}
                 OR lease_heartbeat_at < ${input.staleBefore})
          ORDER BY requested_at ASC, id ASC
          LIMIT 1
          FOR UPDATE SKIP LOCKED)
      RETURNING *`);
    const row = rows.rows[0];
    return row === undefined ? null : toRow(row);
  }

  async heartbeat(input: {
    readonly id: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<boolean> {
    const rows = await this.db.execute(sql`
      UPDATE legacy_compaction_runs SET lease_heartbeat_at = ${input.now}
       WHERE id = ${input.id}::uuid AND lease_owner = ${input.leaseOwner}
         AND state = ANY(${textArray(LEGACY_COMPACTION_ACTIVE_STATES)})
      RETURNING id`);
    return rows.rows.length > 0;
  }

  async beginArchiving(input: {
    readonly id: string;
    readonly tenantId: string;
    readonly leaseOwner: string;
    readonly now: Date;
  }): Promise<'ADVANCED' | 'IMPORT_NOT_READY' | 'RECONCILIATION_NOT_CLEAN' | 'LEASE_LOST'> {
    return this.db.transaction(async (tx) => {
      // The lock FIRST, the readiness AFTER: an import's insert takes the same lock, so the
      // two decisions are serialised and each sees the other's committed row.
      await lockLegacyImportExclusion(tx, input.tenantId);
      const readiness = await this.importReadiness(input.tenantId, tx);
      if (!readiness.completed || readiness.inFlight) return 'IMPORT_NOT_READY';
      // v0.9.7: nothing is archived, let alone deleted, unless the finished import's balance
      // reconciliation is recorded and names none of the blocking differences.
      if (!readiness.reconciled) return 'RECONCILIATION_NOT_CLEAN';
      const moved = await this.advance(
        {
          id: input.id,
          leaseOwner: input.leaseOwner,
          from: 'REQUESTED',
          to: 'ARCHIVING',
          now: input.now,
        },
        tx,
      );
      return moved ? 'ADVANCED' : 'LEASE_LOST';
    });
  }

  async advance(
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
  ): Promise<boolean> {
    const terminal = input.to === 'COMPLETED' || input.to === 'FAILED';
    const rows = await (tx ?? this.db).execute(sql`
      UPDATE legacy_compaction_runs SET
        state = ${input.to},
        updated_at = ${input.now},
        lease_heartbeat_at = ${input.now},
        cursor = ${input.cursor === undefined ? sql`cursor` : sql`${input.cursor}::uuid`},
        archive_backup_id = ${input.archiveBackupId === undefined ? sql`archive_backup_id` : sql`${input.archiveBackupId}::uuid`},
        before = ${input.before === undefined ? sql`before` : sql`${JSON.stringify(input.before)}::jsonb`},
        after = ${input.after === undefined ? sql`after` : sql`${JSON.stringify(input.after)}::jsonb`},
        failure_code = ${input.failureCode === undefined ? sql`failure_code` : sql`${input.failureCode}`},
        deleted = deleted + ${input.addDeleted ?? 0},
        deduplicated = deduplicated + ${input.addDeduplicated ?? 0},
        stripped = stripped + ${input.addStripped ?? 0},
        finished_at = ${terminal ? sql`${input.now}` : sql`NULL`},
        lease_owner = ${terminal ? sql`NULL` : sql`lease_owner`}
       WHERE id = ${input.id}::uuid AND state = ${input.from} AND lease_owner = ${input.leaseOwner}
      RETURNING id`);
    return rows.rows.length > 0;
  }

  async deleteDropBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly types: readonly LegacyHistoryRecordType[];
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<{ readonly count: number; readonly last: string | null }> {
    return this.batch(
      tx,
      sql`DELETE FROM legacy_history_records WHERE id IN (SELECT id FROM picked)`,
      sql`tenant_id = ${input.tenantId}::uuid AND record_type = ANY(${textArray(input.types)})`,
      input.after,
      input.limit,
    );
  }

  /**
   * `archive_row` records OF THE INVOICE TABLE whose invoice has a row in
   * `legacy_invoice_archive` — the copy every invoice reader reads. An archive row of any
   * other table, or an invoice row with no twin, is kept.
   */
  async dedupBatch(
    tx: Executor,
    input: { readonly tenantId: string; readonly after: string | null; readonly limit: number },
  ): Promise<{ readonly count: number; readonly last: string | null }> {
    return this.batch(
      tx,
      sql`DELETE FROM legacy_history_records WHERE id IN (SELECT id FROM picked)`,
      sql`tenant_id = ${input.tenantId}::uuid AND record_type = 'archive_row'
          AND lower(payload->'provenance'->>'source_table') = 'invoice'
          AND EXISTS (SELECT 1 FROM legacy_invoice_archive twin
                       WHERE twin.tenant_id = legacy_history_records.tenant_id
                         AND twin.invoice_key = legacy_history_records.payload->'provenance'->>'source_pk')`,
      input.after,
      input.limit,
    );
  }

  /** Removes the given top-level keys where their value is `false`, from kept rows. */
  async stripBatch(
    tx: Executor,
    input: {
      readonly tenantId: string;
      readonly keys: readonly string[];
      readonly after: string | null;
      readonly limit: number;
    },
  ): Promise<{ readonly count: number; readonly last: string | null }> {
    const keys = textArray(input.keys);
    return this.batch(
      tx,
      sql`UPDATE legacy_history_records AS h
             SET payload = h.payload - (
               SELECT coalesce(array_agg(e.key), ARRAY[]::text[])
                 FROM jsonb_each(h.payload) AS e(key, value)
                WHERE e.key = ANY(${keys}) AND e.value = 'false'::jsonb)
           WHERE h.id IN (SELECT id FROM picked)`,
      sql`tenant_id = ${input.tenantId}::uuid AND payload ?| ${keys}`,
      input.after,
      input.limit,
    );
  }

  /**
   * One keyset batch: the next `limit` ids after `after` that match, then `action` over
   * them. Returns how many were acted on and the last id SCANNED — the cursor advances past
   * every picked row, so a batch is never revisited.
   */
  private async batch(
    tx: Executor,
    action: SQL,
    where: SQL,
    after: string | null,
    limit: number,
  ): Promise<{ count: number; last: string | null }> {
    const picked = sql`picked AS (
      SELECT id FROM legacy_history_records
       WHERE ${where} ${after === null ? sql`` : sql`AND id > ${after}::uuid`}
       ORDER BY id ASC LIMIT ${limit})`;
    const last = await tx.execute<{ last: string | null; n: number }>(
      sql`WITH ${picked} SELECT max(id::text) AS last, count(*)::int AS n FROM picked`,
    );
    const head = last.rows[0];
    if (head === undefined || head.n === 0 || head.last === null) return { count: 0, last: null };
    const done = await tx.execute(sql`WITH ${picked} ${action}`);
    return { count: done.rowCount ?? 0, last: head.last };
  }

  /**
   * One batch of the CLEARING stage: up to `limit` rows of the tenant from the FIRST of
   * `LEGACY_CLEANUP_CLEARED_TABLES` that still has any, deleted. Nothing to resume from: a
   * batch removes what it picked, so the next one (after a crash too) takes the next rows.
   *
   * The trial decisions go first and lift, in the same statement, the trial limit the import
   * imposed: an override of 0 the decision itself wrote (`override_before` NULL), still 0 and
   * not set again since (`set_at` ≤ the decision's `recorded_at`). An operator's override — one
   * that was there before the import, or set after it — is never touched.
   *
   * Staging rows are cleared only for archive runs that FINISHED (COMPLETED or FAILED): a run
   * still staging or verifying owns its rows.
   */
  async clearBatch(
    tx: Executor,
    input: { readonly tenantId: string; readonly limit: number },
  ): Promise<ClearBatchResult> {
    const tenant = sql`${input.tenantId}::uuid`;
    for (const table of LEGACY_CLEANUP_CLEARED_TABLES) {
      const result = await this.clearOne(tx, table, tenant, input.limit);
      if (result.rows > 0) return { table, ...result };
    }
    return { table: null, rows: 0, overridesLifted: 0 };
  }

  private async clearOne(
    tx: Executor,
    table: LegacyCleanupClearedTable,
    tenant: SQL,
    limit: number,
  ): Promise<{ readonly rows: number; readonly overridesLifted: number }> {
    switch (table) {
      case 'legacy_trial_eligibility': {
        const done = await tx.execute<{ rows: number; lifted: number }>(sql`
          WITH picked AS MATERIALIZED (
            SELECT customer_id, decision, override_before, override_after, recorded_at
              FROM legacy_trial_eligibility
             WHERE tenant_id = ${tenant}
             ORDER BY customer_id LIMIT ${limit}),
          lifted AS (
            DELETE FROM trial_limit_overrides o USING picked p
             WHERE o.tenant_id = ${tenant} AND o.customer_id = p.customer_id
               AND p.decision IN ('LEGACY_NO_TRIALS', 'LEGACY_TRIAL_CONSUMED', 'LEGACY_LIMIT_UNREADABLE')
               AND p.override_before IS NULL AND p.override_after = 0
               AND o.trial_limit = 0 AND o.set_at <= p.recorded_at
            RETURNING o.customer_id),
          gone AS (
            DELETE FROM legacy_trial_eligibility e USING picked p
             WHERE e.tenant_id = ${tenant} AND e.customer_id = p.customer_id
            RETURNING e.customer_id)
          SELECT (SELECT count(*)::int FROM gone) AS rows, (SELECT count(*)::int FROM lifted) AS lifted`);
        const row = done.rows[0];
        return { rows: row?.rows ?? 0, overridesLifted: row?.lifted ?? 0 };
      }
      case 'legacy_service_candidates':
        return this.deleted(
          tx,
          sql`DELETE FROM legacy_service_candidates WHERE id IN (
                SELECT id FROM legacy_service_candidates WHERE tenant_id = ${tenant}
                 ORDER BY id LIMIT ${limit})`,
        );
      case 'legacy_import_map':
        return this.deleted(
          tx,
          sql`DELETE FROM legacy_import_map m USING (
                SELECT legacy_table, legacy_id FROM legacy_import_map WHERE tenant_id = ${tenant}
                 ORDER BY legacy_table, legacy_id LIMIT ${limit}) AS picked
               WHERE m.tenant_id = ${tenant} AND m.legacy_table = picked.legacy_table
                 AND m.legacy_id = picked.legacy_id`,
        );
      case 'legacy_invoice_archive_staging':
        return this.deleted(
          tx,
          sql`DELETE FROM legacy_invoice_archive_staging s USING (
                SELECT st.run_id, st.source_table, st.source_key
                  FROM legacy_invoice_archive_staging st
                  JOIN legacy_invoice_archive_runs r ON r.tenant_id = st.tenant_id AND r.id = st.run_id
                 WHERE st.tenant_id = ${tenant} AND r.state IN ('COMPLETED', 'FAILED')
                 ORDER BY st.run_id, st.source_table, st.source_key LIMIT ${limit}) AS picked
               WHERE s.run_id = picked.run_id AND s.source_table = picked.source_table
                 AND s.source_key = picked.source_key`,
        );
    }
  }

  private async deleted(
    tx: Executor,
    statement: SQL,
  ): Promise<{ readonly rows: number; readonly overridesLifted: number }> {
    const done = await tx.execute(statement);
    return { rows: done.rowCount ?? 0, overridesLifted: 0 };
  }

  async authorise(tx: Executor, runId: string): Promise<void> {
    // `true`: transaction-local, gone at COMMIT or ROLLBACK.
    await tx.execute(sql`SELECT set_config('nexa.legacy_compaction_run', ${runId}, true)`);
  }

  async measure(tenantId: string): Promise<CompactionSizes> {
    const sizes = await this.db.execute<{ name: string; bytes: string | null }>(sql`
      SELECT t.name, pg_total_relation_size(to_regclass(t.name))::text AS bytes
        FROM unnest(${textArray(MEASURED_TABLES)}) AS t(name)`);
    const counts = await this.db.execute<{ record_type: string; n: number }>(sql`
      SELECT record_type, count(*)::int AS n FROM legacy_history_records
       WHERE tenant_id = ${tenantId}::uuid GROUP BY record_type`);
    return {
      tables: Object.fromEntries(sizes.rows.map((row) => [row.name, row.bytes ?? '0'])),
      recordTypes: Object.fromEntries(counts.rows.map((row) => [row.record_type, row.n])),
    };
  }

  /**
   * VACUUM FULL of the compacted tables. Outside any transaction (PostgreSQL refuses one
   * inside), and it takes an ACCESS EXCLUSIVE lock on each table for its duration: the
   * legacy history pages wait while it runs — the maintenance window the UI announces.
   */
  async vacuum(): Promise<void> {
    await this.db.execute(sql`VACUUM (FULL, ANALYZE) legacy_history_records`);
    // v0.9.7: the tables CLEARING emptied give their space back too.
    for (const table of LEGACY_CLEANUP_CLEARED_TABLES) {
      await this.db.execute(sql`VACUUM (FULL, ANALYZE) ${sql.identifier(table)}`);
    }
  }
}
