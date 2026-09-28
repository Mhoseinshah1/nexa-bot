import { sql } from 'drizzle-orm';
import type { TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  PendingPaymentReminderRepository,
  PendingReminderCandidate,
} from '../application/pending-payment-reminder.service.js';

interface Row {
  readonly id: string;
  readonly customer_id: string;
  readonly opened_at: string;
  readonly expires_at: string;
}

function toCandidate(row: Row): PendingReminderCandidate {
  return {
    id: row.id,
    customerId: row.customer_id as UserId,
    openedAt: new Date(row.opened_at),
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * WP-A9: the pending-payment reminder's two candidate queries.
 *
 * Both end in the same `NOT EXISTS` over `customer_notifications`, and that is what keeps a
 * pass finite and idle scans free: an attempt already reminded about is not a candidate
 * again, so the bound is spent only on attempts that are owed something. The notification
 * row is the ONLY record — there is no reminder table for this lane, because the subject
 * key already says "told once".
 *
 * `first_bot_instance_id IS NOT NULL` is the same forward-progress rule from the other
 * side: a customer with no durable bot link cannot be told, `CustomerNotifier.notify`
 * enqueues nothing for them, and without this filter they would come back on every pass
 * until the attempt lapsed.
 */
export class DrizzlePendingPaymentReminderRepository implements PendingPaymentReminderRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async listPaymentCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly noticeAt: Date;
      readonly leadAt: Date;
      readonly openedBefore: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly PendingReminderCandidate[]> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT p.id, p.customer_id, p.created_at AS opened_at, p.expires_at
      FROM payments p
      JOIN customers c ON c.tenant_id = p.tenant_id AND c.id = p.customer_id
      WHERE p.tenant_id = ${tenantId}
        AND p.state = 'PENDING'
        AND p.method = 'MANUAL_TRANSFER'
        AND p.expires_at IS NOT NULL
        AND p.expires_at >= ${bounds.noticeAt}
        AND p.expires_at <= ${bounds.leadAt}
        AND p.created_at <= ${bounds.openedBefore}
        AND p.customer_signalled_at IS NULL
        AND c.first_bot_instance_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_receipts pr
          WHERE pr.tenant_id = p.tenant_id AND pr.payment_id = p.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM customer_notifications n
          WHERE n.tenant_id = p.tenant_id
            AND n.kind = 'PAYMENT_PENDING_REMINDER'
            AND n.subject_id = p.id
        )
      ORDER BY p.expires_at ASC, p.id ASC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as Row[]).map(toCandidate);
  }

  async listOrderCandidates(
    scope: TenantContext,
    bounds: {
      readonly now: Date;
      readonly noticeAt: Date;
      readonly leadAt: Date;
      readonly openedBefore: Date;
    },
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly PendingReminderCandidate[]> {
    const tenantId = requireTenantId(scope);
    /*
     * `total_amount > 0`: a free order (a trial) has nothing to pay, and a reminder to pay
     * nothing is noise. `COALESCE(confirmed_at, created_at)`: the order began AWAITING
     * payment when it was confirmed, which is the moment the age floor is measured from.
     */
    const result = await this.exec(tx).execute(sql`
      SELECT o.id, o.customer_id, COALESCE(o.confirmed_at, o.created_at) AS opened_at,
             o.expires_at
      FROM orders o
      JOIN customers c ON c.tenant_id = o.tenant_id AND c.id = o.customer_id
      WHERE o.tenant_id = ${tenantId}
        AND o.state = 'AWAITING_PAYMENT'
        AND o.total_amount > 0
        AND o.expires_at IS NOT NULL
        AND o.expires_at >= ${bounds.noticeAt}
        AND o.expires_at <= ${bounds.leadAt}
        AND COALESCE(o.confirmed_at, o.created_at) <= ${bounds.openedBefore}
        AND c.first_bot_instance_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payments p
          WHERE p.tenant_id = o.tenant_id
            AND p.order_id = o.id
            AND p.state IN ('PENDING', 'CONFIRMED', 'UNKNOWN')
        )
        AND NOT EXISTS (
          SELECT 1 FROM customer_notifications n
          WHERE n.tenant_id = o.tenant_id
            AND n.kind = 'ORDER_PENDING_REMINDER'
            AND n.subject_id = o.id
        )
      ORDER BY o.expires_at ASC, o.id ASC
      LIMIT ${limit}
    `);
    return (result.rows as unknown as Row[]).map(toCandidate);
  }
}
