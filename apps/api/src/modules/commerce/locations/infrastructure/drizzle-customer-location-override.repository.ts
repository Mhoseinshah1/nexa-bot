import { and, eq } from 'drizzle-orm';
import type { LocationChangeLimits, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import { customerLocationChangeOverrides } from '../../../../infrastructure/persistence/schema.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerLocationOverrideRecord,
  CustomerLocationOverrideRepository,
} from '../application/ports.js';

/** `customer_location_change_overrides`: one row per customer, the trial override's shape. */
export class DrizzleCustomerLocationOverrideRepository implements CustomerLocationOverrideRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerLocationOverrideRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(customerLocationChangeOverrides)
      .where(
        and(
          eq(customerLocationChangeOverrides.tenantId, tenantId),
          eq(customerLocationChangeOverrides.customerId, customerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      customerId: row.customerId as UserId,
      limits: {
        cooldownHours: row.cooldownHours,
        maxChanges: row.maxChanges,
        periodDays: row.periodDays,
      },
      setAt: row.setAt,
    };
  }

  async upsert(
    scope: TenantContext,
    customerId: UserId,
    limits: LocationChangeLimits,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const before = await this.find(scope, customerId, tx);
    if (
      before !== null &&
      before.limits.cooldownHours === limits.cooldownHours &&
      before.limits.maxChanges === limits.maxChanges &&
      before.limits.periodDays === limits.periodDays
    ) {
      return false;
    }
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(customerLocationChangeOverrides)
      .values({ tenantId, customerId, ...limits, setAt: now })
      .onConflictDoUpdate({
        target: [
          customerLocationChangeOverrides.tenantId,
          customerLocationChangeOverrides.customerId,
        ],
        set: { ...limits, setAt: now },
      });
    return true;
  }

  async remove(scope: TenantContext, customerId: UserId, tx: TransactionScope): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(customerLocationChangeOverrides)
      .where(
        and(
          eq(customerLocationChangeOverrides.tenantId, tenantId),
          eq(customerLocationChangeOverrides.customerId, customerId),
        ),
      )
      .returning({ customerId: customerLocationChangeOverrides.customerId });
    return rows.length > 0;
  }
}
