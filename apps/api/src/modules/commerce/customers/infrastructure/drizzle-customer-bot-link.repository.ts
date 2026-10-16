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

  async botExists(
    scope: TenantContext,
    botInstanceId: BotInstanceId,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const r = await this.exec(tx).execute(
      sql`SELECT 1 AS one FROM bot_instances WHERE tenant_id = ${tenantId} AND id = ${botInstanceId}`,
    );
    return r.rows.length > 0;
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
    const r = await this.exec(tx).execute(sql`
      UPDATE customers c
         SET first_bot_instance_id = ${input.botInstanceId}, updated_at = ${input.now}
       WHERE c.tenant_id = ${tenantId}
         AND c.first_bot_instance_id IS NULL
         AND c.id IN (
           SELECT c2.id
             FROM customers c2
             JOIN legacy_import_map m
               ON m.tenant_id = c2.tenant_id AND m.entity_type = 'CUSTOMER'
              AND m.status = 'IMPORTED' AND m.entity_id = c2.id
            WHERE c2.tenant_id = ${tenantId} AND c2.first_bot_instance_id IS NULL
            ORDER BY c2.id
            LIMIT ${input.limit}
              FOR UPDATE OF c2 SKIP LOCKED)
      RETURNING c.id`);
    return r.rows.length;
  }
}
