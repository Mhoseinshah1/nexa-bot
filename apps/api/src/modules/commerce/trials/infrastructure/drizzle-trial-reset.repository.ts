import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { CustomerStatus, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { trialResets } from '../../../../infrastructure/persistence/schema.js';
import type {
  TrialResetCursor,
  TrialResetPreview,
  TrialResetRecord,
  TrialResetRepository,
} from '../application/ports.js';

/** Global trial resets, in PostgreSQL. Every query leads with the tenant. */
export class DrizzleTrialResetRepository implements TrialResetRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async preview(scope: TenantContext, sampleSize: number): Promise<TrialResetPreview> {
    const tenantId = requireTenantId(scope);
    /*
     * The same predicate `execute` stamps by, so the dry run describes the reset it
     * previews — and `execute` refuses when, by the time it runs, it no longer does.
     */
    const totals = await this.db.execute<{ grants: number; customers: number }>(sql`
      SELECT count(*)::int AS grants, count(DISTINCT customer_id)::int AS customers
        FROM trial_grants
       WHERE tenant_id = ${tenantId} AND released_at IS NULL AND reset_at IS NULL
    `);
    const sample = await this.db.execute<{
      customer_id: string;
      telegram_user_id: string;
      username: string | null;
      first_name: string | null;
      status: string;
      grants: number;
    }>(sql`
      SELECT c.id AS customer_id, c.telegram_user_id, c.username, c.first_name, c.status,
             count(*)::int AS grants
        FROM trial_grants g
        JOIN customers c ON c.tenant_id = g.tenant_id AND c.id = g.customer_id
       WHERE g.tenant_id = ${tenantId} AND g.released_at IS NULL AND g.reset_at IS NULL
       GROUP BY c.id, c.telegram_user_id, c.username, c.first_name, c.status
       ORDER BY grants DESC, c.id ASC
       LIMIT ${sampleSize}
    `);
    const total = totals.rows[0];
    return {
      affectedGrants: total?.grants ?? 0,
      affectedCustomers: total?.customers ?? 0,
      sample: sample.rows.map((row) => ({
        customer: {
          id: row.customer_id as UserId,
          telegramUserId: row.telegram_user_id,
          username: row.username,
          firstName: row.first_name,
          status: row.status as CustomerStatus,
        },
        grants: row.grants,
      })),
    };
  }

  async execute(
    scope: TenantContext,
    input: {
      readonly id: string;
      readonly actorAdminId: string;
      readonly reason: string;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<TrialResetRecord | null> {
    const tenantId = requireTenantId(scope);
    /*
     * ONE statement: stamp, then record what was stamped.
     *
     * The record's counts are aggregated from the stamping's own RETURNING, so the
     * history row and the grants it covers cannot disagree. `HAVING count(*) > 0` writes
     * no record when nothing was stamped, which is also the only case in which the
     * UPDATE wrote nothing.
     *
     * The stamped rows point at a `trial_resets` row the same statement inserts. That
     * holds because a NOT DEFERRABLE foreign key is checked at the end of the STATEMENT,
     * not of each sub-statement — which `trial-admin.test.ts` exercises on every reset.
     *
     * The `WHERE` is re-evaluated against a row's newest version if the UPDATE had to
     * wait for its lock (READ COMMITTED), so a grant released or reset by a transaction
     * that committed while this one waited is skipped rather than stamped twice.
     */
    const result = await this.exec(tx).execute<{
      id: string;
      actor_admin_id: string;
      reason: string;
      affected_grants: number;
      affected_customers: number;
      created_at: Date;
    }>(sql`
      WITH stamped AS (
        UPDATE trial_grants
           SET reset_at = ${input.now}, reset_id = ${input.id}
         WHERE tenant_id = ${tenantId} AND released_at IS NULL AND reset_at IS NULL
        RETURNING customer_id
      )
      INSERT INTO trial_resets
             (id, tenant_id, actor_admin_id, reason, affected_grants, affected_customers, created_at)
      SELECT ${input.id}, ${tenantId}, ${input.actorAdminId}, ${input.reason},
             count(*), count(DISTINCT customer_id), ${input.now}
        FROM stamped
      HAVING count(*) > 0
      RETURNING id, actor_admin_id, reason, affected_grants, affected_customers, created_at
    `);
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      actorAdminId: row.actor_admin_id,
      reason: row.reason,
      affectedGrants: row.affected_grants,
      affectedCustomers: row.affected_customers,
      createdAt: new Date(row.created_at),
    };
  }

  async findById(scope: TenantContext, id: string): Promise<TrialResetRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select()
      .from(trialResets)
      .where(and(eq(trialResets.tenantId, tenantId), eq(trialResets.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    limit: number,
    cursor: TrialResetCursor | null,
  ): Promise<{
    readonly items: readonly TrialResetRecord[];
    readonly nextCursor: TrialResetCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const at = cursor === null ? null : sql`${cursor.createdAt}::timestamptz`;
    const rows = await this.db
      .select({
        row: trialResets,
        createdAtText: sql<string>`to_char(${trialResets.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(trialResets)
      .where(
        and(
          eq(trialResets.tenantId, tenantId),
          ...(at === null || cursor === null
            ? []
            : [
                or(
                  sql`${trialResets.createdAt} < ${at}`,
                  and(sql`${trialResets.createdAt} = ${at}`, sql`${trialResets.id} < ${cursor.id}`),
                ),
              ]),
        ),
      )
      .orderBy(desc(trialResets.createdAt), desc(trialResets.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((entry) => toRecord(entry.row)),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.row.id }
          : null,
    };
  }
}

function toRecord(row: typeof trialResets.$inferSelect): TrialResetRecord {
  return {
    id: row.id,
    actorAdminId: row.actorAdminId,
    reason: row.reason,
    affectedGrants: row.affectedGrants,
    affectedCustomers: row.affectedCustomers,
    createdAt: row.createdAt,
  };
}
