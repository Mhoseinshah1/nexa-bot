import { sql, type SQL } from 'drizzle-orm';
import type {
  LegacyCompactionFailureCode,
  LegacyCompactionState,
  LegacyHistoryRecordType,
} from '@nexa/contracts';
import { LEGACY_COMPACTION_ACTIVE_STATES } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import { lockLegacyImportExclusion } from '../../../../infrastructure/persistence/legacy-import-exclusion.js';
import type {
  CompactionSizes,
  LegacyCompactionRepository,
  LegacyCompactionRow,
} from '../application/ports.js';

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

  async completedExists(tenantId: string, tx?: Executor): Promise<boolean> {
    const rows = await (tx ?? this.db).execute(sql`
      SELECT 1 FROM legacy_compaction_runs
       WHERE tenant_id = ${tenantId}::uuid AND state = 'COMPLETED' LIMIT 1`);
    return rows.rows.length > 0;
  }

  async importReadiness(
    tenantId: string,
    tx?: Executor,
  ): Promise<{ readonly completed: boolean; readonly inFlight: boolean }> {
    const rows = await (tx ?? this.db).execute<{ completed: boolean; in_flight: boolean }>(sql`
      SELECT
        EXISTS (SELECT 1 FROM legacy_nxpkg_imports
                 WHERE tenant_id = ${tenantId}::uuid AND status = ANY(${textArray(IMPORT_DONE)})) AS completed,
        EXISTS (SELECT 1 FROM legacy_nxpkg_imports
                 WHERE tenant_id = ${tenantId}::uuid
                   AND NOT (status = ANY(${textArray(IMPORT_TERMINAL)}))) AS in_flight`);
    const row = rows.rows[0];
    return { completed: row?.completed === true, inFlight: row?.in_flight === true };
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
  }): Promise<'ADVANCED' | 'IMPORT_NOT_READY' | 'LEASE_LOST'> {
    return this.db.transaction(async (tx) => {
      // The lock FIRST, the readiness AFTER: an import's insert takes the same lock, so the
      // two decisions are serialised and each sees the other's committed row.
      await lockLegacyImportExclusion(tx, input.tenantId);
      const readiness = await this.importReadiness(input.tenantId, tx);
      if (!readiness.completed || readiness.inFlight) return 'IMPORT_NOT_READY';
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
    await this.db.execute(sql`VACUUM (FULL, ANALYZE) legacy_invoice_archive_staging`);
  }
}
