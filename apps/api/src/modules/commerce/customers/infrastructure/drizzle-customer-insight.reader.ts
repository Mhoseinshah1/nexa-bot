import { sql } from 'drizzle-orm';
import type { TenantContext, UserId } from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerInsightReader,
  LedgerAggregateRow,
  OrderAggregateRow,
  PaymentAggregateRow,
} from '../application/customer-insight.service.js';

/**
 * Customer 360's aggregates (§11.7), each a GROUP BY over one table's own rows for one
 * customer, through the `(customer_id, created_at, id)` index each of those tables has.
 * Sums are `numeric` in SQL and text on the way out, so a total past 2^53 survives.
 */
export class DrizzleCustomerInsightReader implements CustomerInsightReader {
  constructor(private readonly db: Database) {}

  async orders(scope: TenantContext, customerId: UserId): Promise<readonly OrderAggregateRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT state, purpose, currency, count(*)::int AS count,
             coalesce(sum(total_amount), 0)::text AS total,
             coalesce(sum(discount_amount), 0)::text AS discount
      FROM orders
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      GROUP BY state, purpose, currency
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      state: String(row.state),
      purpose: String(row.purpose),
      currency: String(row.currency),
      count: Number(row.count),
      total: BigInt(String(row.total)),
      discount: BigInt(String(row.discount)),
    }));
  }

  async payments(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<readonly PaymentAggregateRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT state, currency, count(*)::int AS count, coalesce(sum(amount), 0)::text AS total
      FROM payments
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      GROUP BY state, currency
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      state: String(row.state),
      currency: String(row.currency),
      count: Number(row.count),
      total: BigInt(String(row.total)),
    }));
  }

  async ledger(scope: TenantContext, customerId: UserId): Promise<readonly LedgerAggregateRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT reason, direction, currency, count(*)::int AS count,
             coalesce(sum(amount), 0)::text AS total
      FROM wallet_entries
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      GROUP BY reason, direction, currency
      ORDER BY reason, direction, currency
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      reason: String(row.reason),
      direction: String(row.direction),
      currency: String(row.currency),
      count: Number(row.count),
      total: BigInt(String(row.total)),
    }));
  }

  async services(
    scope: TenantContext,
    customerId: UserId,
  ): Promise<readonly { readonly state: string; readonly count: number }[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT state, count(*)::int AS count
      FROM services
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      GROUP BY state
      ORDER BY state
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      state: String(row.state),
      count: Number(row.count),
    }));
  }
}
