import { and, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { CustomerStatus, TenantContext, UserId } from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { customers, trialLimitOverrides } from '../../../../infrastructure/persistence/schema.js';
import type {
  TrialOverrideCursor,
  TrialOverrideListRow,
  TrialOverrideRecord,
  TrialOverrideRepository,
} from '../application/ports.js';

/** Custom trial limits, in PostgreSQL. Every query leads with the tenant. */
/** Overrides per INSERT: 4 parameters a row. */
const OVERRIDE_INSERT_CHUNK = 10_000;
/** Keys per `IN (…)` read. */
const OVERRIDE_READ_CHUNK = 10_000;

export class DrizzleTrialOverrideRepository implements TrialOverrideRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async find(
    scope: TenantContext,
    customerId: UserId,
    tx?: TransactionScope,
  ): Promise<TrialOverrideRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(trialLimitOverrides)
      .where(
        and(
          eq(trialLimitOverrides.tenantId, tenantId),
          eq(trialLimitOverrides.customerId, customerId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    return { customerId: row.customerId as UserId, limit: row.trialLimit, setAt: row.setAt };
  }

  /** `find` for many customers in one read; a customer with no override is not in the map. */
  async findMany(
    scope: TenantContext,
    customerIds: readonly UserId[],
    tx?: TransactionScope,
  ): Promise<ReadonlyMap<string, TrialOverrideRecord>> {
    const tenantId = requireTenantId(scope);
    const out = new Map<string, TrialOverrideRecord>();
    for (let i = 0; i < customerIds.length; i += OVERRIDE_READ_CHUNK) {
      const rows = await this.exec(tx)
        .select()
        .from(trialLimitOverrides)
        .where(
          and(
            eq(trialLimitOverrides.tenantId, tenantId),
            inArray(trialLimitOverrides.customerId, customerIds.slice(i, i + OVERRIDE_READ_CHUNK)),
          ),
        );
      for (const row of rows) {
        out.set(row.customerId, {
          customerId: row.customerId as UserId,
          limit: row.trialLimit,
          setAt: row.setAt,
        });
      }
    }
    return out;
  }

  /** `upsert` for many customers (each named once): multi-row upserts, same rows. */
  async upsertMany(
    scope: TenantContext,
    overrides: readonly { readonly customerId: UserId; readonly limit: number }[],
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    for (let i = 0; i < overrides.length; i += OVERRIDE_INSERT_CHUNK) {
      await this.exec(tx)
        .insert(trialLimitOverrides)
        .values(
          overrides.slice(i, i + OVERRIDE_INSERT_CHUNK).map((o) => ({
            tenantId,
            customerId: o.customerId,
            trialLimit: o.limit,
            setAt: now,
          })),
        )
        .onConflictDoUpdate({
          target: [trialLimitOverrides.tenantId, trialLimitOverrides.customerId],
          set: { trialLimit: sql`excluded.trial_limit`, setAt: sql`excluded.set_at` },
        });
    }
  }

  async upsert(
    scope: TenantContext,
    customerId: UserId,
    limit: number,
    now: Date,
    tx: TransactionScope,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await this.exec(tx)
      .insert(trialLimitOverrides)
      .values({ tenantId, customerId, trialLimit: limit, setAt: now })
      .onConflictDoUpdate({
        target: [trialLimitOverrides.tenantId, trialLimitOverrides.customerId],
        set: { trialLimit: limit, setAt: now },
      });
  }

  async remove(scope: TenantContext, customerId: UserId, tx: TransactionScope): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(trialLimitOverrides)
      .where(
        and(
          eq(trialLimitOverrides.tenantId, tenantId),
          eq(trialLimitOverrides.customerId, customerId),
        ),
      )
      .returning({ customerId: trialLimitOverrides.customerId });
    return rows.length > 0;
  }

  async list(
    scope: TenantContext,
    limit: number,
    cursor: TrialOverrideCursor | null,
  ): Promise<{
    readonly items: readonly TrialOverrideListRow[];
    readonly nextCursor: TrialOverrideCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const at = cursor === null ? null : sql`${cursor.setAt}::timestamptz`;
    const rows = await this.db
      .select({
        customerId: trialLimitOverrides.customerId,
        trialLimit: trialLimitOverrides.trialLimit,
        setAt: trialLimitOverrides.setAt,
        // PostgreSQL's own microsecond text, never a `Date`: see `WalletCursor`.
        setAtText: sql<string>`to_char(${trialLimitOverrides.setAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        telegramUserId: customers.telegramUserId,
        username: customers.username,
        firstName: customers.firstName,
        status: customers.status,
        // The same predicate `countCounting` applies, so the list and the customer's
        // own card show one number. A display figure: no lock is held.
        used: sql<number>`(
          SELECT count(*)::int FROM trial_grants g
           WHERE g.tenant_id = ${trialLimitOverrides.tenantId}
             AND g.customer_id = ${trialLimitOverrides.customerId}
             AND g.released_at IS NULL AND g.reset_at IS NULL
        )`,
      })
      .from(trialLimitOverrides)
      .innerJoin(
        customers,
        and(
          eq(customers.tenantId, trialLimitOverrides.tenantId),
          eq(customers.id, trialLimitOverrides.customerId),
        ),
      )
      .where(
        and(
          eq(trialLimitOverrides.tenantId, tenantId),
          ...(at === null || cursor === null
            ? []
            : [
                or(
                  sql`${trialLimitOverrides.setAt} < ${at}`,
                  and(
                    sql`${trialLimitOverrides.setAt} = ${at}`,
                    sql`${trialLimitOverrides.customerId} < ${cursor.customerId}`,
                  ),
                ),
              ]),
        ),
      )
      .orderBy(desc(trialLimitOverrides.setAt), desc(trialLimitOverrides.customerId))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        customer: {
          id: row.customerId as UserId,
          telegramUserId: row.telegramUserId,
          username: row.username,
          firstName: row.firstName,
          status: row.status as CustomerStatus,
        },
        limit: row.trialLimit,
        used: row.used,
        setAt: row.setAt,
      })),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { setAt: last.setAtText, customerId: last.customerId }
          : null,
    };
  }
}
