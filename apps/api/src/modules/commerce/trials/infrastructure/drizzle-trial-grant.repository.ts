import { and, count, eq, isNull } from 'drizzle-orm';
import type { OrderId, ProductId, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { trialGrants } from '../../../../infrastructure/persistence/schema.js';
import type {
  TrialGrantDraft,
  TrialGrantRecord,
  TrialGrantRepository,
} from '../application/ports.js';

/** Trial grants, in PostgreSQL. Every query leads with the tenant. */
export class DrizzleTrialGrantRepository implements TrialGrantRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async countCounting(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ value: count() })
      .from(trialGrants)
      .where(
        and(
          eq(trialGrants.tenantId, tenantId),
          eq(trialGrants.customerId, customerId),
          isNull(trialGrants.releasedAt),
          // A reset grant stops counting exactly as a released one does (ADR-0015).
          isNull(trialGrants.resetAt),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async create(
    scope: TenantContext,
    draft: TrialGrantDraft,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(trialGrants)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        productId: draft.productId,
        serviceId: draft.serviceId,
        createdAt: draft.now,
      })
      .onConflictDoNothing({ target: [trialGrants.tenantId, trialGrants.orderId] })
      .returning({ id: trialGrants.id });
    return rows.length > 0;
  }

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: TransactionScope,
  ): Promise<TrialGrantRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(trialGrants)
      .where(and(eq(trialGrants.tenantId, tenantId), eq(trialGrants.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      customerId: row.customerId as UserId,
      orderId: row.orderId as OrderId,
      productId: row.productId as ProductId,
      serviceId: row.serviceId,
      createdAt: row.createdAt,
      releasedAt: row.releasedAt,
    };
  }

  async release(
    scope: TenantContext,
    orderId: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(trialGrants)
      .set({ releasedAt: at })
      .where(
        and(
          eq(trialGrants.tenantId, tenantId),
          eq(trialGrants.orderId, orderId),
          isNull(trialGrants.releasedAt),
        ),
      )
      .returning({ id: trialGrants.id });
    return rows.length > 0;
  }
}
