import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  PAYMENT_OPS_QUEUES,
  type PaymentGatewayProvider,
  type PaymentOpsQueue,
  type TenantContext,
  type TimePeriod,
} from '@nexa/contracts';
import type { Database } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import type {
  PaymentAttentionReader,
  PaymentAttentionRow,
} from '../application/payment-operations.service.js';
import { paymentOpsQueueCondition } from './payment-ops-queue-sql.js';

/**
 * The attention counts in ONE statement: the tenant's payments in the window, grouped by
 * route, each queue a `count(*) FILTER (WHERE <the queue's own predicate>)`. The predicates
 * are the list's (`paymentOpsQueueCondition`), never restated, so a count and the list it
 * opens are one question asked twice.
 *
 * The row set is narrowed to payments in at least one queue before grouping, so a route
 * whose payments all settled quietly produces no row.
 */
export class DrizzlePaymentAttentionReader implements PaymentAttentionReader {
  constructor(private readonly db: Database) {}

  async counts(
    scope: TenantContext,
    window: TimePeriod | null,
  ): Promise<readonly PaymentAttentionRow[]> {
    const tenantId = requireTenantId(scope);
    const conditions: SQL[] = [eq(payments.tenantId, tenantId)];
    if (window !== null) {
      conditions.push(
        sql`${payments.createdAt} >= ${window.start.toISOString()}::timestamptz`,
        sql`${payments.createdAt} < ${window.end.toISOString()}::timestamptz`,
      );
    }
    const predicates = PAYMENT_OPS_QUEUES.map((queue) => paymentOpsQueueCondition(queue));
    conditions.push(sql`(${sql.join(predicates, sql` OR `)})`);

    const columns = Object.fromEntries(
      PAYMENT_OPS_QUEUES.map((queue, index) => [
        queue,
        sql<number>`(count(*) FILTER (WHERE ${predicates[index]}))::int`,
      ]),
    ) as Record<PaymentOpsQueue, SQL.Aliased<number> | SQL<number>>;

    const rows = await this.db
      .select({ gatewayProvider: payments.gatewayProvider, ...columns })
      .from(payments)
      .where(and(...conditions))
      .groupBy(payments.gatewayProvider)
      // Deterministic: routes by name, the routeless last.
      .orderBy(sql`${payments.gatewayProvider} ASC NULLS LAST`);

    return rows.map((row) => {
      const record = row as unknown as Record<string, unknown>;
      return {
        gatewayProvider: (record['gatewayProvider'] ?? null) as PaymentGatewayProvider | null,
        counts: Object.fromEntries(
          PAYMENT_OPS_QUEUES.map((queue) => [queue, Number(record[queue] ?? 0)]),
        ) as Record<PaymentOpsQueue, number>,
      };
    });
  }
}
