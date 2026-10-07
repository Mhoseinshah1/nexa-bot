import { sql, type SQL } from 'drizzle-orm';
import {
  TICKET_AWAITING_SUPPORT_STATUSES,
  type OrderPurpose,
  type OrderState,
  type PaymentMethod,
  type PaymentState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerInsightReader,
  CustomerWorkspaceReader,
  LedgerAggregateRow,
  OrderAggregateRow,
  PaymentAggregateRow,
  WorkspaceOrderRow,
  WorkspacePaymentRow,
} from '../application/customer-insight.service.js';

/**
 * Customer 360's aggregates (§11.7), each a GROUP BY over one table's own rows for one
 * customer, through the `(customer_id, created_at, id)` index each of those tables has.
 * Sums are `numeric` in SQL and text on the way out, so a total past 2^53 survives.
 */
export class DrizzleCustomerInsightReader
  implements CustomerInsightReader, CustomerWorkspaceReader
{
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

  // --- Workspace (roadmap B5) -----------------------------------------------------------
  //
  // Each count is `count(*)` over at most `cap` rows (`capped`), so the work is bounded and
  // not only the answer; each is the predicate of the page it links to, narrowed to the
  // customer, through an index that leads with the tenant or the customer:
  //
  //   tickets                 `tickets_tenant_customer_idx` (tenant, customer, status)
  //   business_conversations  `business_conversations_inbox_priority_idx`'s leading
  //                           (tenant, state = 'HANDOFF_REQUIRED'), then the customer
  //   payments                `payments_customer_created_idx` (customer, created_at, id)
  //   services                `services_unreconciled_idx` (partial)
  //   orders                  the `(customer_id, created_at, id)` index, walked backwards

  async tickets(
    scope: TenantContext,
    customerId: UserId,
    cap: number,
  ): Promise<{ readonly awaitingSupport: number; readonly open: number }> {
    const tenantId = requireTenantId(scope);
    const [awaitingSupport, open] = await Promise.all([
      this.count(
        capped(
          sql`SELECT 1 FROM tickets k
               WHERE k.tenant_id = ${tenantId} AND k.customer_id = ${customerId}
                 AND k.status = ANY(${textArray(TICKET_AWAITING_SUPPORT_STATUSES)})`,
          cap,
        ),
      ),
      this.count(
        capped(
          sql`SELECT 1 FROM tickets k
               WHERE k.tenant_id = ${tenantId} AND k.customer_id = ${customerId}
                 AND k.status <> 'CLOSED'`,
          cap,
        ),
      ),
    ]);
    return { awaitingSupport, open };
  }

  async businessHandoffs(scope: TenantContext, customerId: UserId, cap: number): Promise<number> {
    const tenantId = requireTenantId(scope);
    return this.count(
      capped(
        sql`SELECT 1 FROM business_conversations c
             WHERE c.tenant_id = ${tenantId} AND (c.state = 'HANDOFF_REQUIRED')
               AND c.customer_id = ${customerId}`,
        cap,
      ),
    );
  }

  async unknownPayments(scope: TenantContext, customerId: UserId, cap: number): Promise<number> {
    const tenantId = requireTenantId(scope);
    return this.count(
      capped(
        sql`SELECT 1 FROM payments p
             WHERE p.tenant_id = ${tenantId} AND p.customer_id = ${customerId}
               AND p.state = 'UNKNOWN'`,
        cap,
      ),
    );
  }

  async unreconciledServices(
    scope: TenantContext,
    customerId: UserId,
    cap: number,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    return this.count(
      capped(
        sql`SELECT 1 FROM services s
             WHERE s.tenant_id = ${tenantId} AND s.customer_id = ${customerId}
               AND s.state = 'UNRECONCILED'`,
        cap,
      ),
    );
  }

  async latestOrders(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly WorkspaceOrderRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT id, line_title, purpose, state, total_amount::text AS total_amount, currency,
             created_at
      FROM orders
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      lineTitle: String(row.line_title),
      purpose: String(row.purpose) as OrderPurpose,
      state: String(row.state) as OrderState,
      totalAmount: BigInt(String(row.total_amount)),
      currency: String(row.currency),
      createdAt: instant(row.created_at),
    }));
  }

  async latestPayments(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
  ): Promise<readonly WorkspacePaymentRow[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.db.execute(sql`
      SELECT id, reference, method, state, amount::text AS amount, currency, created_at
      FROM payments
      WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
    `);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      id: String(row.id),
      reference: String(row.reference),
      method: String(row.method) as PaymentMethod,
      state: String(row.state) as PaymentState,
      amount: BigInt(String(row.amount)),
      currency: String(row.currency),
      createdAt: instant(row.created_at),
    }));
  }

  private async count(query: SQL): Promise<number> {
    const result = await this.db.execute(query);
    const [row] = result.rows as { n?: unknown }[];
    return Number(row?.n ?? 0);
  }
}

function textArray(values: readonly string[]): SQL {
  return sql`${sql.param([...values])}::text[]`;
}

/** `count(*)` over at most `cap` rows of `rows`: the work is bounded, not only the answer. */
function capped(rows: SQL, cap: number): SQL {
  return sql`SELECT count(*)::int AS n FROM (${rows} LIMIT ${cap}) capped`;
}

/** A `timestamptz` as the driver returns it through `execute` — a Date or an ISO string. */
function instant(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}
