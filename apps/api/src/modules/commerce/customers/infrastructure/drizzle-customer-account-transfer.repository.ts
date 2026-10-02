import { and, eq, sql } from 'drizzle-orm';
import type { CurrencyCode, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { customerAccountTransfers } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  AccountTransferDraft,
  AccountTransferFacts,
  AccountTransferRecord,
  CustomerAccountTransferRepository,
} from '../application/customer-account-transfer.service.js';

/**
 * The account transfer's reads and its one write (`docs/customer-account-transfer-audit.md`).
 *
 * `facts` is one round trip of COUNTS over every table §2 of the audit names, for one
 * source customer, read on the caller's transaction — so under the transfer's customer
 * locks it sees what the move will act on. Each count is a sub-select through that table's
 * own customer index.
 */
export class DrizzleCustomerAccountTransferRepository implements CustomerAccountTransferRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async facts(scope: TenantContext, sourceId: UserId, tx?: unknown): Promise<AccountTransferFacts> {
    const tenantId = requireTenantId(scope);
    const services = await this.exec(tx).execute(sql`
      SELECT s.id, s.state, s.is_trial, s.provider_username,
             EXISTS (
               SELECT 1 FROM service_refund_requests r
               WHERE r.tenant_id = s.tenant_id AND r.service_id = s.id AND r.state = 'COMPLETED'
             ) AS refunded_away
      FROM services s
      WHERE s.tenant_id = ${tenantId} AND s.customer_id = ${sourceId}
      ORDER BY s.id
    `);
    const counts = await this.exec(tx).execute(sql`
      SELECT
        (SELECT count(*)::int FROM orders o
          WHERE o.tenant_id = ${tenantId} AND o.customer_id = ${sourceId}) AS orders,
        (SELECT count(*)::int FROM orders o
          WHERE o.tenant_id = ${tenantId} AND o.customer_id = ${sourceId}
            AND o.state = 'AWAITING_PAYMENT') AS awaiting_orders,
        (SELECT count(*)::int FROM orders o
          WHERE o.tenant_id = ${tenantId} AND o.customer_id = ${sourceId}
            AND o.state = 'PAID'
            AND o.purpose IN ('NEW_SERVICE', 'CUSTOM_SERVICE', 'TRIAL')
            AND NOT EXISTS (SELECT 1 FROM services s
                            WHERE s.tenant_id = o.tenant_id AND s.order_id = o.id)) AS undelivered_orders,
        (SELECT count(*)::int FROM payments p
          WHERE p.tenant_id = ${tenantId} AND p.customer_id = ${sourceId}) AS payments,
        (SELECT count(*)::int FROM payments p
          WHERE p.tenant_id = ${tenantId} AND p.customer_id = ${sourceId}
            AND p.state IN ('PENDING', 'UNKNOWN')) AS pending_payments,
        (SELECT count(*)::int FROM resellers r
          WHERE r.tenant_id = ${tenantId} AND r.customer_id = ${sourceId}) AS reseller_rows,
        (SELECT count(*)::int FROM order_cashback c
          WHERE c.tenant_id = ${tenantId} AND c.customer_id = ${sourceId}
            AND c.state = 'PENDING') AS pending_cashback,
        (SELECT count(*)::int FROM order_referral_commissions c
          WHERE c.tenant_id = ${tenantId} AND c.referrer_id = ${sourceId}
            AND c.state = 'PENDING') AS pending_commissions,
        (SELECT count(*)::int FROM bulk_operation_items b
          WHERE b.tenant_id = ${tenantId} AND b.customer_id = ${sourceId}
            AND b.state IN ('PENDING', 'PLANNED')) AS pending_bulk,
        (SELECT count(*)::int FROM referrals f
          WHERE f.tenant_id = ${tenantId} AND f.referrer_id = ${sourceId}) AS referred,
        (SELECT count(*)::int FROM referrals f
          WHERE f.tenant_id = ${tenantId} AND f.referee_id = ${sourceId}) AS referred_by,
        (SELECT count(*)::int FROM tickets t
          WHERE t.tenant_id = ${tenantId} AND t.customer_id = ${sourceId}
            AND t.status <> 'CLOSED') AS open_tickets,
        (SELECT count(*)::int FROM trial_limit_overrides t
          WHERE t.tenant_id = ${tenantId} AND t.customer_id = ${sourceId}) AS trial_override,
        (SELECT count(*)::int FROM customer_location_change_overrides l
          WHERE l.tenant_id = ${tenantId} AND l.customer_id = ${sourceId}) AS location_override
    `);
    const row = (counts.rows as Record<string, unknown>[])[0] ?? {};
    const n = (key: string) => Number(row[key] ?? 0);
    return {
      services: (services.rows as Record<string, unknown>[]).map((service) => ({
        id: String(service.id),
        state: String(service.state),
        isTrial: service.is_trial === true,
        providerUsername: String(service.provider_username),
        refundedAway: service.refunded_away === true,
      })),
      orders: n('orders'),
      ordersInProgress: n('awaiting_orders') + n('undelivered_orders'),
      payments: n('payments'),
      pendingPayments: n('pending_payments'),
      isReseller: n('reseller_rows') > 0,
      pendingRewards: n('pending_cashback') + n('pending_commissions'),
      pendingBulkItems: n('pending_bulk'),
      referredCustomers: n('referred'),
      referredBy: n('referred_by') > 0,
      openTickets: n('open_tickets'),
      trialOverride: n('trial_override') > 0,
      locationOverride: n('location_override') > 0,
    };
  }

  async isReseller(scope: TenantContext, customerId: UserId, tx?: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const result = await this.exec(tx).execute(sql`
      SELECT 1 FROM resellers WHERE tenant_id = ${tenantId} AND customer_id = ${customerId}
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  async findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<AccountTransferRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(customerAccountTransfers)
      .where(
        and(
          eq(customerAccountTransfers.tenantId, tenantId),
          eq(customerAccountTransfers.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const found = rows[0];
    return found === undefined ? null : toRecord(found);
  }

  async create(
    scope: TenantContext,
    draft: AccountTransferDraft,
    tx: TransactionScope,
  ): Promise<AccountTransferRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(customerAccountTransfers)
      .values({
        id: draft.id,
        tenantId,
        fromCustomerId: draft.fromCustomerId,
        toCustomerId: draft.toCustomerId,
        idempotencyKey: draft.idempotencyKey,
        serviceIds: [...draft.serviceIds],
        walletAmount: draft.walletAmount,
        currency: draft.currency,
        debitEntryId: draft.debitEntryId,
        creditEntryId: draft.creditEntryId,
        fingerprint: draft.fingerprint,
        reason: draft.reason,
        actorAdminId: draft.actorAdminId,
        correlationId: draft.correlationId,
        createdAt: draft.now,
      })
      .returning();
    const written = rows[0];
    if (written === undefined) throw new Error('the account transfer insert returned no row');
    return toRecord(written);
  }
}

function toRecord(row: typeof customerAccountTransfers.$inferSelect): AccountTransferRecord {
  return {
    id: row.id,
    fromCustomerId: row.fromCustomerId as UserId,
    toCustomerId: row.toCustomerId as UserId,
    idempotencyKey: row.idempotencyKey,
    serviceIds: Array.isArray(row.serviceIds) ? (row.serviceIds as string[]) : [],
    walletAmount: row.walletAmount,
    currency: row.currency as CurrencyCode,
    fingerprint: row.fingerprint,
    createdAt: row.createdAt,
  };
}
