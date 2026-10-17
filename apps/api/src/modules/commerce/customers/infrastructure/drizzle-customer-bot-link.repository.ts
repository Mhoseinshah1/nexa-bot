import { sql } from 'drizzle-orm';
import type { BotInstanceId, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerBotLinkRepository } from '../application/customer-bot-link.service.js';

/**
 * Customers the legacy importer created and nobody has linked to a bot yet.
 * Eligible = NULL link AND an IMPORTED `legacy_import_map` CUSTOMER row naming the customer.
 */
export class DrizzleCustomerBotLinkRepository implements CustomerBotLinkRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async botStatus(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<string | null> {
    const tenantId = requireTenantId(scope);
    // Inside a batch the bot row is held FOR SHARE: a concurrent stop or disable waits for the
    // batch, and the next batch sees it.
    const r = await this.exec(tx).execute(
      tx === undefined
        ? sql`SELECT status FROM bot_instances WHERE tenant_id = ${tenantId} AND id = ${botInstanceId}`
        : sql`SELECT status FROM bot_instances WHERE tenant_id = ${tenantId} AND id = ${botInstanceId} FOR SHARE`,
    );
    return (r.rows[0] as { status: string } | undefined)?.status ?? null;
  }

  async serialiseAndPriorTargets(
    scope: TenantContext,
    auditAction: string,
    tx: unknown,
  ): Promise<readonly string[]> {
    const tenantId = requireTenantId(scope);
    const db = this.exec(tx);
    // One link at a time per tenant: two runs never interleave their batches.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`customers-link-bot:${tenantId}`}, 0))`,
    );
    // The bots earlier runs linked customers to (their audit rows name the bot, nothing else).
    const r = await db.execute(sql`
      SELECT DISTINCT entity_id FROM audit_logs
       WHERE tenant_id = ${tenantId} AND action = ${auditAction} AND result = 'SUCCESS'
         AND entity_id IS NOT NULL`);
    return r.rows.map((row) => String((row as { entity_id: string }).entity_id));
  }

  async activeBots(scope: TenantContext): Promise<readonly BotInstanceId[]> {
    const tenantId = requireTenantId(scope);
    const r = await this.db.execute(sql`
      SELECT id FROM bot_instances WHERE tenant_id = ${tenantId} AND status = 'ACTIVE'
       ORDER BY created_at, id`);
    return (r.rows as { id: string }[]).map((row) => row.id as BotInstanceId);
  }

  async countEligible(scope: TenantContext, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const r = await this.exec(tx).execute(sql`
      SELECT count(*)::int AS n
        FROM customers c
        JOIN legacy_import_map m
          ON m.tenant_id = c.tenant_id AND m.entity_type = 'CUSTOMER'
         AND m.status = 'IMPORTED' AND m.entity_id = c.id
       WHERE c.tenant_id = ${tenantId} AND c.first_bot_instance_id IS NULL`);
    return Number((r.rows[0] as { n: number } | undefined)?.n ?? 0);
  }

  async linkBatch(
    scope: TenantContext,
    input: { botInstanceId: BotInstanceId; limit: number; now: Date },
    tx?: unknown,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    // The batch is picked ONCE in a MATERIALIZED CTE and the UPDATE joins to it. Written as
    // `WHERE id IN (SELECT … LIMIT n FOR UPDATE)`, PostgreSQL may evaluate the sub-select
    // more than once and update more than `limit` rows (the integration test caught 3 rows
    // in a batch of 2), so a batch would not be a batch.
    const r = await this.exec(tx).execute(sql`
      WITH picked AS MATERIALIZED (
        SELECT c2.id
          FROM customers c2
          JOIN legacy_import_map m
            ON m.tenant_id = c2.tenant_id AND m.entity_type = 'CUSTOMER'
           AND m.status = 'IMPORTED' AND m.entity_id = c2.id
         WHERE c2.tenant_id = ${tenantId} AND c2.first_bot_instance_id IS NULL
         ORDER BY c2.id
         LIMIT ${input.limit}
           FOR UPDATE OF c2 SKIP LOCKED)
      UPDATE customers c
         SET first_bot_instance_id = ${input.botInstanceId}, updated_at = ${input.now}
        FROM picked
       WHERE c.id = picked.id
         AND c.tenant_id = ${tenantId}
         AND c.first_bot_instance_id IS NULL
      RETURNING c.id`);
    return r.rows.length;
  }
}
