import { and, eq, sql } from 'drizzle-orm';
import type { TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers } from '../../../../infrastructure/persistence/schema.js';
import type { PersonalDiscountReader } from '../../pricing/application/ports.js';

/** A customer's personal discount as stored (R10 D3). */
export interface PersonalDiscountRecord {
  /** 0 when none. */
  readonly percent: number;
  /** When an operator last changed it; null: never. */
  readonly setAt: Date | null;
}

/**
 * `customers.personal_discount_percent`, read by the pricing boundary and written by
 * Customer 360's control (R10 D3).
 *
 * Its own repository rather than more methods on `DrizzleCustomerRepository`, because
 * `CustomerRecord` is the row every customer read returns (and every fixture builds): the
 * percent is read where a price is decided and on the customer's page, nowhere else.
 */
export class DrizzlePersonalDiscountRepository implements PersonalDiscountReader {
  constructor(private readonly db: Database) {}

  /** `lock` takes the row `FOR UPDATE`, the wallet's own customer-row lock: see below. */
  async percentOf(
    scope: TenantContext,
    customerId: string,
    options: { readonly lock: boolean },
    tx?: unknown,
  ): Promise<number | null> {
    const found = await this.find(scope, customerId as UserId, tx, options.lock);
    return found === null ? null : found.percent;
  }

  /**
   * The stored percent, optionally under the customer row's lock.
   *
   * `FOR UPDATE` and not `FOR SHARE`, deliberately. Confirmation reads it under the lock so
   * that an operator's change either committed first (and is seen) or waits; the same
   * transaction may go on to take the wallet's lock on this very row (`lockCustomer`,
   * `FOR UPDATE`). Two confirmations each holding `FOR SHARE` and each then asking for
   * `FOR UPDATE` would deadlock; taking the stronger lock first queues the second instead.
   */
  async find(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
    lock = false,
  ): Promise<PersonalDiscountRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.exec(tx)
      .select({
        percent: customers.personalDiscountPercent,
        setAt: customers.personalDiscountSetAt,
      })
      .from(customers)
      .where(and(eq(customers.tenantId, tenantId), eq(customers.id, customerId)));
    const rows = lock ? await query.for('update') : await query;
    const row = rows[0];
    return row === undefined ? null : { percent: row.percent, setAt: row.setAt };
  }

  /**
   * Set the percent, as a conditional UPDATE naming a CHANGE: `false` when the row already
   * holds exactly that percent, so a replay or a double submit changes nothing and keeps
   * the first `set_at`.
   */
  async set(
    scope: TenantContext,
    customerId: UserId,
    percent: number,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(customers)
      .set({ personalDiscountPercent: percent, personalDiscountSetAt: now, updatedAt: now })
      .where(
        and(
          eq(customers.tenantId, tenantId),
          eq(customers.id, customerId),
          sql`${customers.personalDiscountPercent} IS DISTINCT FROM ${percent}`,
        ),
      )
      .returning({ id: customers.id });
    return rows.length > 0;
  }

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }
}
