import { sql, type SQL } from 'drizzle-orm';
import type { AudienceDefinition, AudienceSampleCustomer, TenantContext } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type { AudienceOptions, AudienceReader, AudienceSummary } from '../application/ports.js';
import { audienceCustomersQuery, fingerprintOf } from './audience-sql.js';

export class DrizzleAudienceReader implements AudienceReader {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  private async rows<T>(query: SQL, tx?: unknown): Promise<T[]> {
    const result = await this.exec(tx).execute<T & Record<string, unknown>>(query);
    return result.rows as T[];
  }

  async summarise(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    tx?: unknown,
  ): Promise<AudienceSummary> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.rows<{ customers: number; reachable: number; fingerprint: string }>(
      sql`SELECT count(*)::int AS customers,
                 count(*) FILTER (WHERE a.bot_instance_id IS NOT NULL)::int AS reachable,
                 ${fingerprintOf(sql`a.customer_id`)} AS fingerprint
            FROM (${audienceCustomersQuery({ tenantId, definition, asOf })}) a`,
      tx,
    );
    return {
      customers: row?.customers ?? 0,
      reachable: row?.reachable ?? 0,
      fingerprint: row?.fingerprint ?? '',
    };
  }

  async sample(
    scope: TenantContext,
    definition: AudienceDefinition,
    asOf: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly AudienceSampleCustomer[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.rows<{
      id: string;
      first_name: string | null;
      username: string | null;
      telegram_user_id: string;
    }>(
      sql`SELECT c.id, c.first_name, c.username, c.telegram_user_id
            FROM (${audienceCustomersQuery({ tenantId, definition, asOf })}) a
            JOIN customers c ON c.tenant_id = ${tenantId}::uuid AND c.id = a.customer_id
           ORDER BY c.created_at DESC, c.id DESC
           LIMIT ${limit}`,
      tx,
    );
    return rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      username: row.username,
      telegramUserId: row.telegram_user_id,
    }));
  }

  async options(scope: TenantContext): Promise<AudienceOptions> {
    const tenantId = requireTenantId(scope);
    const [tiers, products, panels] = await Promise.all([
      this.rows<{ id: string; name: string }>(
        sql`SELECT id, name FROM reseller_tiers WHERE tenant_id = ${tenantId}::uuid
             ORDER BY lower(name), id`,
      ),
      this.rows<{ id: string; title: string }>(
        sql`SELECT id, title FROM products WHERE tenant_id = ${tenantId}::uuid
             ORDER BY lower(title), id`,
      ),
      this.rows<{ id: string; name: string }>(
        sql`SELECT id, name FROM panels WHERE tenant_id = ${tenantId}::uuid AND archived_at IS NULL
             ORDER BY lower(name), id`,
      ),
    ]);
    return { resellerTiers: tiers, products, panels };
  }
}
