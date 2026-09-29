import { and, asc, desc, eq, ilike, or, sql, type SQL } from 'drizzle-orm';
import { RESELLER_GRANT_DIMENSION, money } from '@nexa/contracts';
import type {
  Calendar,
  CurrencyCode,
  Money,
  OrderPurpose,
  ResellerEntitlementDimension,
  OrderState,
  ResellerGrantKind,
  ResellerOverrideMode,
  ResellerPriceLayer,
  ResellerPricingMode,
  ResellerStatus,
  TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customers,
  orderResellerTerms,
  orders,
  resellerEntitlementOverrides,
  resellerGrantOverrides,
  resellerMinimumNotices,
  resellerTierGrants,
  resellerTiers,
  resellers,
  tenants,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  OrderResellerTermsRecord,
  ResellerCursor,
  ResellerListing,
  ResellerMinimumNoticeWrite,
  ResellerOverrideRecord,
  ResellerPurchaseRecord,
  ResellerRecord,
  ResellerRepository,
  ResellerTierGrantRecord,
  ResellerTierListing,
  ResellerTierRecord,
  ResellerWrite,
  TierWrite,
} from '../application/ports.js';

/** The stored form of "every subject of this kind". */
const EVERY_SUBJECT = '*';

function exec(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

/** A unique violation, from PostgreSQL through drizzle, with or without a wrapping cause. */
function isUniqueViolation(error: unknown): boolean {
  const code = (e: unknown): unknown =>
    typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  const cause =
    typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return code(error) === '23505' || code(cause) === '23505';
}

function toTier(row: typeof resellerTiers.$inferSelect): ResellerTierRecord {
  return {
    id: row.id,
    name: row.name,
    pricingMode: row.pricingMode as ResellerPricingMode,
    discountPercentage: row.discountPercentage,
    creditLimit: money(row.creditLimitAmount, row.creditLimitCurrency as CurrencyCode),
    monthlyMinimum: minimumOf(row.monthlyMinimumAmount, row.monthlyMinimumCurrency),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** A nullable minimum pair (a CHECK keeps both halves or neither). */
function minimumOf(amount: bigint | null, currency: string | null): Money | null {
  return amount === null || currency === null ? null : money(amount, currency as CurrencyCode);
}

function toReseller(row: typeof resellers.$inferSelect): ResellerRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    tierId: row.tierId,
    status: row.status as ResellerStatus,
    pricingMode: row.pricingMode as ResellerOverrideMode,
    discountPercentage: row.discountPercentage,
    creditLimit:
      row.creditLimitAmount === null || row.creditLimitCurrency === null
        ? null
        : money(row.creditLimitAmount, row.creditLimitCurrency as CurrencyCode),
    monthlyMinimum: minimumOf(row.monthlyMinimumAmount, row.monthlyMinimumCurrency),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toGrant(row: { kind: string; subject: string }): ResellerTierGrantRecord {
  return {
    kind: row.kind as ResellerGrantKind,
    subject: row.subject === EVERY_SUBJECT ? null : row.subject,
  };
}

function displayName(row: {
  firstName: string | null;
  lastName: string | null;
  username: string | null;
}): string | null {
  const name = [row.firstName, row.lastName].filter((p) => p !== null && p !== '').join(' ');
  if (name !== '') return name;
  return row.username !== null && row.username !== '' ? row.username : null;
}

/** Tiers, grants, resellers and purchase terms, in PostgreSQL. Every query carries the tenant. */
export class DrizzleResellerRepository implements ResellerRepository {
  constructor(private readonly db: Database) {}

  // -- Tiers ------------------------------------------------------------------------

  async createTier(
    scope: TenantContext,
    input: TierWrite & { readonly id: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(resellerTiers)
      .values({
        id: input.id,
        tenantId,
        name: input.name,
        pricingMode: input.pricingMode,
        discountPercentage: input.discountPercentage,
        creditLimitAmount: input.creditLimit.amountMinor,
        creditLimitCurrency: input.creditLimit.currency,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ id: resellerTiers.id });
    return inserted.length === 1;
  }

  async updateTier(
    scope: TenantContext,
    id: string,
    input: TierWrite & { readonly now: Date },
    tx: unknown,
  ): Promise<ResellerTierRecord | 'NAME_TAKEN' | null> {
    const tenantId = requireTenantId(scope);
    const [clash] = await exec(this.db, tx)
      .select({ id: resellerTiers.id })
      .from(resellerTiers)
      .where(
        and(
          eq(resellerTiers.tenantId, tenantId),
          sql`lower(${resellerTiers.name}) = lower(${input.name})`,
          sql`${resellerTiers.id} <> ${id}::uuid`,
        ),
      );
    if (clash !== undefined) return 'NAME_TAKEN';
    try {
      const [row] = await exec(this.db, tx)
        .update(resellerTiers)
        .set({
          name: input.name,
          pricingMode: input.pricingMode,
          discountPercentage: input.discountPercentage,
          creditLimitAmount: input.creditLimit.amountMinor,
          creditLimitCurrency: input.creditLimit.currency,
          updatedAt: input.now,
        })
        .where(and(eq(resellerTiers.tenantId, tenantId), eq(resellerTiers.id, id)))
        .returning();
      return row === undefined ? null : toTier(row);
    } catch (error) {
      // A concurrent rename to the same name, committed between the check and this write.
      if (isUniqueViolation(error)) return 'NAME_TAKEN';
      throw error;
    }
  }

  async findTier(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ResellerTierRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellerTiers)
      .where(and(eq(resellerTiers.tenantId, tenantId), eq(resellerTiers.id, id)));
    return row === undefined ? null : toTier(row);
  }

  async shareTier(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ResellerTierRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellerTiers)
      .where(and(eq(resellerTiers.tenantId, tenantId), eq(resellerTiers.id, id)))
      .for('share');
    return row === undefined ? null : toTier(row);
  }

  async lockTier(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ResellerTierRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellerTiers)
      .where(and(eq(resellerTiers.tenantId, tenantId), eq(resellerTiers.id, id)))
      .for('update');
    return row === undefined ? null : toTier(row);
  }

  async grantsOf(
    scope: TenantContext,
    tierId: string,
    tx?: unknown,
  ): Promise<readonly ResellerTierGrantRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({ kind: resellerTierGrants.kind, subject: resellerTierGrants.subject })
      .from(resellerTierGrants)
      .where(and(eq(resellerTierGrants.tenantId, tenantId), eq(resellerTierGrants.tierId, tierId)))
      .orderBy(asc(resellerTierGrants.kind), asc(resellerTierGrants.subject));
    return rows.map(toGrant);
  }

  async replaceGrants(
    scope: TenantContext,
    tierId: string,
    grants: readonly ResellerTierGrantRecord[],
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = exec(this.db, tx);
    await executor
      .delete(resellerTierGrants)
      .where(and(eq(resellerTierGrants.tenantId, tenantId), eq(resellerTierGrants.tierId, tierId)));
    if (grants.length === 0) return;
    await executor.insert(resellerTierGrants).values(
      grants.map((g) => ({
        tenantId,
        tierId,
        kind: g.kind,
        subject: g.subject ?? EVERY_SUBJECT,
        createdAt: now,
      })),
    );
  }

  async listTiers(scope: TenantContext): Promise<readonly ResellerTierListing[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.db
      .select({
        tier: resellerTiers,
        /*
         * The outer columns are written QUALIFIED, by hand. In a single-table select
         * Drizzle renders `${resellerTiers.id}` as a bare `"id"`, which inside this
         * subquery binds to `r` — so the count compared `r.tier_id = r.id` and was always
         * zero. `resellers-http.test.ts` › counts the resellers on each tier holds it.
         */
        resellerCount: sql<number>`(
          SELECT count(*)::int FROM ${resellers} r
          WHERE r.tenant_id = "reseller_tiers"."tenant_id" AND r.tier_id = "reseller_tiers"."id")`,
      })
      .from(resellerTiers)
      .where(eq(resellerTiers.tenantId, tenantId))
      .orderBy(asc(resellerTiers.createdAt), asc(resellerTiers.id));
    const grants = await this.db
      .select({
        tierId: resellerTierGrants.tierId,
        kind: resellerTierGrants.kind,
        subject: resellerTierGrants.subject,
      })
      .from(resellerTierGrants)
      .where(eq(resellerTierGrants.tenantId, tenantId))
      .orderBy(asc(resellerTierGrants.kind), asc(resellerTierGrants.subject));
    return rows.map((row) => ({
      ...toTier(row.tier),
      grants: grants.filter((g) => g.tierId === row.tier.id).map(toGrant),
      resellerCount: row.resellerCount,
    }));
  }

  // -- Resellers ----------------------------------------------------------------------

  async register(
    scope: TenantContext,
    input: ResellerWrite & { readonly id: string; readonly customerId: string; readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(resellers)
      .values({
        id: input.id,
        tenantId,
        customerId: input.customerId,
        tierId: input.tierId,
        status: input.status,
        pricingMode: input.pricingMode,
        discountPercentage: input.discountPercentage,
        creditLimitAmount: input.creditLimit?.amountMinor ?? null,
        creditLimitCurrency: input.creditLimit?.currency ?? null,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoNothing({ target: [resellers.tenantId, resellers.customerId] })
      .returning({ id: resellers.id });
    return inserted.length === 1;
  }

  async update(
    scope: TenantContext,
    customerId: string,
    input: ResellerWrite & { readonly now: Date },
    tx: unknown,
  ): Promise<ResellerRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(resellers)
      .set({
        tierId: input.tierId,
        status: input.status,
        pricingMode: input.pricingMode,
        discountPercentage: input.discountPercentage,
        creditLimitAmount: input.creditLimit?.amountMinor ?? null,
        creditLimitCurrency: input.creditLimit?.currency ?? null,
        updatedAt: input.now,
      })
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)))
      .returning();
    return row === undefined ? null : toReseller(row);
  }

  async findByCustomer(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellers)
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)));
    return row === undefined ? null : toReseller(row);
  }

  async lockByCustomer(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellers)
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)))
      .for('update');
    return row === undefined ? null : toReseller(row);
  }

  async shareByCustomer(
    scope: TenantContext,
    customerId: string,
    tx: unknown,
  ): Promise<ResellerRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(resellers)
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)))
      .for('share');
    return row === undefined ? null : toReseller(row);
  }

  private listingQuery() {
    return this.db
      .select({
        reseller: resellers,
        // The cursor's position at the column's own precision (microseconds), in the
        // rendering `decodeKeysetCursor` accepts. `Date.toISOString()` is milliseconds:
        // the server refused its own cursor, and a truncated instant is a different row.
        createdAtText: sql<string>`to_char(${resellers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        tier: resellerTiers,
        telegramUserId: customers.telegramUserId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        username: customers.username,
      })
      .from(resellers)
      .innerJoin(
        resellerTiers,
        and(eq(resellerTiers.tenantId, resellers.tenantId), eq(resellerTiers.id, resellers.tierId)),
      )
      .innerJoin(
        customers,
        and(eq(customers.tenantId, resellers.tenantId), eq(customers.id, resellers.customerId)),
      )
      .$dynamic();
  }

  private toListing(row: {
    reseller: typeof resellers.$inferSelect;
    tier: typeof resellerTiers.$inferSelect;
    telegramUserId: string | bigint | number;
    firstName: string | null;
    lastName: string | null;
    username: string | null;
  }): ResellerListing {
    return {
      ...toReseller(row.reseller),
      telegramUserId: String(row.telegramUserId),
      displayName: displayName(row),
      tier: toTier(row.tier),
    };
  }

  async findListing(scope: TenantContext, customerId: string): Promise<ResellerListing | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await this.db
      .select({
        reseller: resellers,
        // The cursor's position at the column's own precision (microseconds), in the
        // rendering `decodeKeysetCursor` accepts. `Date.toISOString()` is milliseconds:
        // the server refused its own cursor, and a truncated instant is a different row.
        createdAtText: sql<string>`to_char(${resellers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        tier: resellerTiers,
        telegramUserId: customers.telegramUserId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        username: customers.username,
      })
      .from(resellers)
      .innerJoin(
        resellerTiers,
        and(eq(resellerTiers.tenantId, resellers.tenantId), eq(resellerTiers.id, resellers.tierId)),
      )
      .innerJoin(
        customers,
        and(eq(customers.tenantId, resellers.tenantId), eq(customers.id, resellers.customerId)),
      )
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)));
    return row === undefined ? null : this.toListing(row);
  }

  async list(
    scope: TenantContext,
    filter: {
      readonly status?: ResellerStatus;
      readonly tierId?: string;
      readonly search?: string;
    },
    limit: number,
    cursor: ResellerCursor | null,
  ): Promise<{ readonly items: readonly ResellerListing[]; readonly next: ResellerCursor | null }> {
    const tenantId = requireTenantId(scope);
    const conditions: (SQL | undefined)[] = [eq(resellers.tenantId, tenantId)];
    if (filter.status !== undefined) conditions.push(eq(resellers.status, filter.status));
    if (filter.tierId !== undefined) conditions.push(eq(resellers.tierId, filter.tierId));
    if (filter.search !== undefined) {
      const term = filter.search.trim();
      const pattern = `%${term.replace(/[\\%_]/gu, (c) => `\\${c}`)}%`;
      conditions.push(
        or(
          /^\d{1,20}$/u.test(term) ? sql`${customers.telegramUserId}::text = ${term}` : sql`false`,
          ilike(customers.firstName, pattern),
          ilike(customers.lastName, pattern),
          ilike(customers.username, pattern),
        ),
      );
    }
    if (cursor !== null) {
      conditions.push(
        sql`(${resellers.createdAt}, ${resellers.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    const rows = await this.listingQuery()
      .where(and(...conditions))
      .orderBy(desc(resellers.createdAt), desc(resellers.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toListing(row)),
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.reseller.id }
          : null,
    };
  }

  // -- Round N: overrides and the monthly minimum --------------------------------------

  async overridesOf(
    scope: TenantContext,
    customerId: string,
    tx?: unknown,
  ): Promise<ResellerOverrideRecord> {
    const tenantId = requireTenantId(scope);
    const executor = exec(this.db, tx);
    const dimensions = await executor
      .select({ dimension: resellerEntitlementOverrides.dimension })
      .from(resellerEntitlementOverrides)
      .where(
        and(
          eq(resellerEntitlementOverrides.tenantId, tenantId),
          eq(resellerEntitlementOverrides.customerId, customerId),
        ),
      )
      .orderBy(asc(resellerEntitlementOverrides.dimension));
    if (dimensions.length === 0) return { dimensions: [], grants: [] };
    const grants = await executor
      .select({ kind: resellerGrantOverrides.kind, subject: resellerGrantOverrides.subject })
      .from(resellerGrantOverrides)
      .where(
        and(
          eq(resellerGrantOverrides.tenantId, tenantId),
          eq(resellerGrantOverrides.customerId, customerId),
        ),
      )
      .orderBy(asc(resellerGrantOverrides.kind), asc(resellerGrantOverrides.subject));
    return {
      dimensions: dimensions.map((d) => d.dimension as ResellerEntitlementDimension),
      grants: grants.map(toGrant),
    };
  }

  async replaceOverrides(
    scope: TenantContext,
    customerId: string,
    override: ResellerOverrideRecord,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    const executor = exec(this.db, tx);
    // The grants go with their dimension rows (ON DELETE CASCADE); deleted explicitly anyway,
    // so the replace does not depend on a foreign key's action to be complete.
    await executor
      .delete(resellerGrantOverrides)
      .where(
        and(
          eq(resellerGrantOverrides.tenantId, tenantId),
          eq(resellerGrantOverrides.customerId, customerId),
        ),
      );
    await executor
      .delete(resellerEntitlementOverrides)
      .where(
        and(
          eq(resellerEntitlementOverrides.tenantId, tenantId),
          eq(resellerEntitlementOverrides.customerId, customerId),
        ),
      );
    if (override.dimensions.length === 0) return;
    await executor.insert(resellerEntitlementOverrides).values(
      override.dimensions.map((dimension) => ({
        tenantId,
        customerId,
        dimension,
        createdAt: now,
      })),
    );
    if (override.grants.length === 0) return;
    await executor.insert(resellerGrantOverrides).values(
      override.grants.map((g) => ({
        tenantId,
        customerId,
        dimension: RESELLER_GRANT_DIMENSION[g.kind],
        kind: g.kind,
        subject: g.subject ?? EVERY_SUBJECT,
        createdAt: now,
      })),
    );
  }

  async setTierMinimum(
    scope: TenantContext,
    tierId: string,
    minimum: Money | null,
    now: Date,
    tx: unknown,
  ): Promise<ResellerTierRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(resellerTiers)
      .set({
        monthlyMinimumAmount: minimum?.amountMinor ?? null,
        monthlyMinimumCurrency: minimum?.currency ?? null,
        updatedAt: now,
      })
      .where(and(eq(resellerTiers.tenantId, tenantId), eq(resellerTiers.id, tierId)))
      .returning();
    return row === undefined ? null : toTier(row);
  }

  async setMinimum(
    scope: TenantContext,
    customerId: string,
    minimum: Money | null,
    now: Date,
    tx: unknown,
  ): Promise<ResellerRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .update(resellers)
      .set({
        monthlyMinimumAmount: minimum?.amountMinor ?? null,
        monthlyMinimumCurrency: minimum?.currency ?? null,
        updatedAt: now,
      })
      .where(and(eq(resellers.tenantId, tenantId), eq(resellers.customerId, customerId)))
      .returning();
    return row === undefined ? null : toReseller(row);
  }

  async listAll(
    scope: TenantContext,
    filter: { readonly activeOnly: boolean },
    limit: number,
    tx?: unknown,
  ): Promise<readonly ResellerListing[]> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({
        reseller: resellers,
        tier: resellerTiers,
        telegramUserId: customers.telegramUserId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        username: customers.username,
      })
      .from(resellers)
      .innerJoin(
        resellerTiers,
        and(eq(resellerTiers.tenantId, resellers.tenantId), eq(resellerTiers.id, resellers.tierId)),
      )
      .innerJoin(
        customers,
        and(eq(customers.tenantId, resellers.tenantId), eq(customers.id, resellers.customerId)),
      )
      .where(
        and(
          eq(resellers.tenantId, tenantId),
          filter.activeOnly ? eq(resellers.status, 'ACTIVE') : undefined,
        ),
      )
      .orderBy(asc(resellers.createdAt), asc(resellers.id))
      .limit(limit);
    return rows.map((row) => this.toListing(row));
  }

  async pageActive(
    scope: TenantContext,
    after: ResellerCursor | null,
    limit: number,
    tx: unknown,
  ): Promise<{ readonly items: readonly ResellerListing[]; readonly next: ResellerCursor | null }> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({
        reseller: resellers,
        createdAtText: sql<string>`to_char(${resellers.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
        tier: resellerTiers,
        telegramUserId: customers.telegramUserId,
        firstName: customers.firstName,
        lastName: customers.lastName,
        username: customers.username,
      })
      .from(resellers)
      .innerJoin(
        resellerTiers,
        and(eq(resellerTiers.tenantId, resellers.tenantId), eq(resellerTiers.id, resellers.tierId)),
      )
      .innerJoin(
        customers,
        and(eq(customers.tenantId, resellers.tenantId), eq(customers.id, resellers.customerId)),
      )
      .where(
        and(
          eq(resellers.tenantId, tenantId),
          eq(resellers.status, 'ACTIVE'),
          after === null
            ? undefined
            : sql`(${resellers.createdAt}, ${resellers.id}) > (${after.createdAt}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(asc(resellers.createdAt), asc(resellers.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => this.toListing(row)),
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.reseller.id }
          : null,
    };
  }

  async presentationOf(
    scope: TenantContext,
    tx: unknown,
  ): Promise<{ readonly timezone: string; readonly calendar: Calendar }> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select({ timezone: tenants.displayTimezone, calendar: tenants.calendar })
      .from(tenants)
      .where(eq(tenants.id, tenantId));
    if (row === undefined) throw new Error(`tenant ${tenantId} not found`);
    return { timezone: row.timezone, calendar: row.calendar as Calendar };
  }

  async noticesIn(
    scope: TenantContext,
    periodStart: Date,
    tx: unknown,
  ): Promise<ReadonlySet<string>> {
    const tenantId = requireTenantId(scope);
    const rows = await exec(this.db, tx)
      .select({ customerId: resellerMinimumNotices.customerId, kind: resellerMinimumNotices.kind })
      .from(resellerMinimumNotices)
      .where(
        and(
          eq(resellerMinimumNotices.tenantId, tenantId),
          eq(resellerMinimumNotices.periodStart, periodStart),
        ),
      );
    return new Set(rows.map((row) => `${row.customerId}:${row.kind}`));
  }

  async raiseNotice(
    scope: TenantContext,
    notice: ResellerMinimumNoticeWrite,
    now: Date,
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(resellerMinimumNotices)
      .values({
        id: notice.id,
        tenantId,
        customerId: notice.customerId,
        kind: notice.kind,
        periodStart: notice.periodStart,
        periodEnd: notice.periodEnd,
        minimumAmount: notice.minimum.amountMinor,
        currency: notice.minimum.currency,
        achievedAmount: notice.achieved,
        raisedAt: now,
      })
      .onConflictDoNothing({
        target: [
          resellerMinimumNotices.tenantId,
          resellerMinimumNotices.customerId,
          resellerMinimumNotices.kind,
          resellerMinimumNotices.periodStart,
        ],
      })
      .returning({ id: resellerMinimumNotices.id });
    return inserted.length === 1;
  }

  // -- Purchase terms ------------------------------------------------------------------

  async recordTerms(
    scope: TenantContext,
    input: Omit<OrderResellerTermsRecord, 'createdAt'> & { readonly now: Date },
    tx: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const inserted = await exec(this.db, tx)
      .insert(orderResellerTerms)
      .values({
        tenantId,
        orderId: input.orderId,
        resellerCustomerId: input.resellerCustomerId,
        tierId: input.tierId,
        tierName: input.tierName,
        layer: input.layer,
        percent: input.percent,
        listAmount: input.listAmount,
        costAmount: input.costAmount,
        promotionAmount: input.promotionAmount,
        saleAmount: input.saleAmount,
        marginAmount: input.marginAmount,
        currency: input.currency,
        botInstanceId: input.botInstanceId,
        createdAt: input.now,
      })
      .onConflictDoNothing()
      .returning({ orderId: orderResellerTerms.orderId });
    return inserted.length === 1;
  }

  async findTerms(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderResellerTermsRecord | null> {
    const tenantId = requireTenantId(scope);
    const [row] = await exec(this.db, tx)
      .select()
      .from(orderResellerTerms)
      .where(
        and(eq(orderResellerTerms.tenantId, tenantId), eq(orderResellerTerms.orderId, orderId)),
      );
    if (row === undefined) return null;
    return {
      orderId: row.orderId,
      resellerCustomerId: row.resellerCustomerId,
      tierId: row.tierId,
      tierName: row.tierName,
      layer: row.layer as ResellerPriceLayer,
      percent: row.percent,
      listAmount: row.listAmount,
      costAmount: row.costAmount,
      promotionAmount: row.promotionAmount,
      saleAmount: row.saleAmount,
      marginAmount: row.marginAmount,
      currency: row.currency as CurrencyCode,
      botInstanceId: row.botInstanceId,
      createdAt: row.createdAt,
    };
  }

  async listPurchases(
    scope: TenantContext,
    resellerCustomerId: string,
    limit: number,
    cursor: ResellerCursor | null,
  ): Promise<{
    readonly items: readonly ResellerPurchaseRecord[];
    readonly next: ResellerCursor | null;
  }> {
    const tenantId = requireTenantId(scope);
    const conditions: (SQL | undefined)[] = [
      eq(orderResellerTerms.tenantId, tenantId),
      eq(orderResellerTerms.resellerCustomerId, resellerCustomerId),
    ];
    if (cursor !== null) {
      conditions.push(
        sql`(${orderResellerTerms.createdAt}, ${orderResellerTerms.orderId}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    /*
     * The margin column is not selected (WP14 §3). The order join is on the terms' own
     * composite key — `(tenant, order, reseller)` is the foreign key — so a row can only
     * ever be joined to the order it was written for.
     */
    const rows = await this.db
      .select({
        orderId: orderResellerTerms.orderId,
        orderState: orders.state,
        purpose: orders.purpose,
        tierName: orderResellerTerms.tierName,
        layer: orderResellerTerms.layer,
        percent: orderResellerTerms.percent,
        listAmount: orderResellerTerms.listAmount,
        costAmount: orderResellerTerms.costAmount,
        promotionAmount: orderResellerTerms.promotionAmount,
        saleAmount: orderResellerTerms.saleAmount,
        currency: orderResellerTerms.currency,
        createdAt: orderResellerTerms.createdAt,
        createdAtText: sql<string>`to_char(${orderResellerTerms.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(orderResellerTerms)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, orderResellerTerms.tenantId),
          eq(orders.id, orderResellerTerms.orderId),
          eq(orders.customerId, orderResellerTerms.resellerCustomerId),
        ),
      )
      .where(and(...conditions))
      .orderBy(desc(orderResellerTerms.createdAt), desc(orderResellerTerms.orderId))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((row) => ({
        orderId: row.orderId,
        orderState: row.orderState as OrderState,
        purpose: row.purpose as OrderPurpose,
        tierName: row.tierName,
        layer: row.layer as ResellerPriceLayer,
        percent: row.percent,
        listAmount: row.listAmount,
        costAmount: row.costAmount,
        promotionAmount: row.promotionAmount,
        saleAmount: row.saleAmount,
        currency: row.currency as CurrencyCode,
        createdAt: row.createdAt,
      })),
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAtText, id: last.orderId }
          : null,
    };
  }
}
