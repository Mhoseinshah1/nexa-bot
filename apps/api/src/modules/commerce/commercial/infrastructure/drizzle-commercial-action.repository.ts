import { and, desc, eq } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  OrderId,
  OrderPurpose,
  ProductId,
  ServiceAddonId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { serviceCommercialActions } from '../../../../infrastructure/persistence/schema.js';
import type {
  CommercialActionDraft,
  CommercialActionRecord,
  CommercialActionRepository,
} from '../application/ports.js';

/**
 * Commercial actions, in PostgreSQL.
 *
 * There is no update and no delete here, and there must not be: the table refuses both
 * through `nexa_reject_mutation`, and a method that tried would be a method whose only
 * outcome is an exception from a trigger. What was bought is what was bought.
 */
export class DrizzleCommercialActionRepository implements CommercialActionRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    draft: CommercialActionDraft,
    tx: TransactionScope,
  ): Promise<CommercialActionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceCommercialActions)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        serviceId: draft.serviceId,
        orderId: draft.orderId,
        kind: draft.kind,
        productId: draft.productId,
        addonId: draft.addonId,
        purchasedTrafficBytes: draft.purchasedTrafficBytes,
        purchasedDurationDays: draft.purchasedDurationDays,
        amount: draft.amount.amountMinor,
        currency: draft.amount.currency,
        createdAt: draft.now,
      })
      /*
       * A replayed command or a second replica loses on
       * `service_commercial_actions_order_key` rather than buying the customer a second
       * renewal. Losing is normal, so it is a null and not an exception.
       */
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<CommercialActionRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceCommercialActions)
      .where(
        and(
          eq(serviceCommercialActions.tenantId, tenantId),
          eq(serviceCommercialActions.orderId, orderId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly CommercialActionRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceCommercialActions)
      .where(
        and(
          eq(serviceCommercialActions.tenantId, tenantId),
          eq(serviceCommercialActions.serviceId, serviceId),
        ),
      )
      .orderBy(desc(serviceCommercialActions.createdAt), desc(serviceCommercialActions.id))
      .limit(limit);
    return rows.map(toRecord);
  }
}

function toRecord(row: typeof serviceCommercialActions.$inferSelect): CommercialActionRecord {
  return {
    id: row.id,
    customerId: row.customerId as UserId,
    serviceId: row.serviceId,
    orderId: row.orderId as OrderId,
    kind: row.kind as Exclude<OrderPurpose, 'NEW_SERVICE'>,
    productId: row.productId as ProductId | null,
    addonId: row.addonId as ServiceAddonId | null,
    purchasedTrafficBytes: row.purchasedTrafficBytes,
    purchasedDurationDays: row.purchasedDurationDays,
    // The pair is reassembled as one value, so nothing downstream reads an amount
    // without its currency. `service_commercial_actions_currency_check` keeps it real.
    amount: money(row.amount, row.currency as CurrencyCode),
    createdAt: row.createdAt,
  };
}
