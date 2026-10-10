import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  PAYMENT_OPS_QUEUES,
  type PaymentGatewayProvider,
  type PaymentOpsQueue,
  type TenantContext,
  type TimePeriod,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { requireTenantId } from '../../../../infrastructure/persistence/unit-of-work.js';
import { payments } from '../../../../infrastructure/persistence/schema.js';
import type {
  PaymentAttentionReader,
  PaymentAttentionRow,
} from '../application/payment-operations.service.js';
import { paymentOpsCandidateIds, paymentOpsQueueCondition } from './payment-ops-queue-sql.js';

/**
 * The attention counts in ONE statement: the tenant's payments in the window, grouped by
 * route, each queue a `count(*) FILTER (WHERE <the queue's own predicate>)`. The predicates
 * are the list's (`paymentOpsQueueCondition`), never restated, so a count and the list it
 * opens are one question asked twice.
 *
 * The row set is narrowed to payments in at least one queue before grouping, so a route
 * whose payments all settled quietly produces no row.
 *
 * Two things keep it fast (FIX-11: measured 2.7–5.8 s per request at 400 000 payments,
 * on a loaded host):
 *
 * - The scan is DRIVEN from the rows that can put a payment in a queue
 *   (`paymentOpsCandidateIds`: pending and unknown payments, invoices with a provider error,
 *   a late completion or a partial, refunds, mismatch holds), not from every payment the
 *   tenant ever took. That set only narrows; the queue predicates still decide every count,
 *   so the answer is the full scan's — `payment-operations.test.ts` holds the two equal.
 * - JIT is OFF for the statement. Nine queues of correlated EXISTS give the planner a cost
 *   in the millions, past `jit_optimize_above_cost`, and PostgreSQL then spent 3.4–4.1 s
 *   COMPILING ~255 expression functions for a statement that then executed in 0.2–0.9 s. That
 *   compile was most of the latency the operator saw, and it is paid again on every request.
 *   `SET LOCAL` confines the setting to this read's own transaction.
 */
export class DrizzlePaymentAttentionReader implements PaymentAttentionReader {
  constructor(private readonly db: Database) {}

  async counts(
    scope: TenantContext,
    window: TimePeriod | null,
  ): Promise<readonly PaymentAttentionRow[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL jit = off`);
      return this.statement(tx, tenantId, window);
    });

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

  /** The statement itself, exposed so the plan test explains exactly what `counts` sends. */
  statement(executor: Executor, tenantId: string, window: TimePeriod | null) {
    const conditions: SQL[] = [
      eq(payments.tenantId, tenantId),
      sql`${payments.id} IN ${paymentOpsCandidateIds(tenantId, window)}`,
    ];
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

    return (
      executor
        .select({ gatewayProvider: payments.gatewayProvider, ...columns })
        .from(payments)
        .where(and(...conditions))
        .groupBy(payments.gatewayProvider)
        // Deterministic: routes by name, the routeless last.
        .orderBy(sql`${payments.gatewayProvider} ASC NULLS LAST`)
    );
  }
}
