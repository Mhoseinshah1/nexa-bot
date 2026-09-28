import { and, asc, eq, sql } from 'drizzle-orm';
import {
  money,
  type CurrencyCode,
  type CustomServiceRuleDimension,
  type CustomServiceRuleLevel,
  type OrderId,
  type TenantContext,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customServiceLocations,
  customServicePriceRules,
  orderCustomServiceTerms,
  panels,
} from '../../../../infrastructure/persistence/schema.js';
import {
  CUSTOM_SERVICE_MAX_RULES,
  type CustomServiceLocationRecord,
  type CustomServiceLocationRepository,
  type CustomServiceRuleRecord,
  type CustomServiceRuleRepository,
  type CustomServiceRuleWrite,
  type OrderCustomServiceTerms,
  type OrderCustomServiceTermsRepository,
} from '../application/ports.js';

/**
 * The class of the tenant's custom-service rules lock. It says what the lock is ABOUT, so
 * another advisory lock keyed on a tenant id cannot collide with it; the object is the
 * tenant's id, hashed, so two tenants never wait for each other (bar a 1-in-2^32 hash
 * collision, which costs only a wait).
 */
export const CUSTOM_SERVICE_RULES_LOCK_CLASS = 0x4353;

function executor(db: Database, tx?: unknown): Executor {
  return (tx as TransactionScope | undefined)?.tx ?? db;
}

type RuleRow = typeof customServicePriceRules.$inferSelect;

function toRule(row: RuleRow): CustomServiceRuleRecord {
  return {
    id: row.id,
    dimension: row.dimension as CustomServiceRuleDimension,
    label: row.label,
    minUnits: row.minUnits,
    maxUnits: row.maxUnits,
    unitPrice: money(row.unitPriceAmount, row.currency as CurrencyCode),
    customerId: row.customerId,
    resellerTierId: row.resellerTierId,
    panelId: row.panelId,
    enabled: row.enabled,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function ruleColumns(write: CustomServiceRuleWrite) {
  return {
    dimension: write.dimension,
    label: write.label,
    minUnits: write.minUnits,
    maxUnits: write.maxUnits,
    unitPriceAmount: write.unitPrice.amountMinor,
    currency: write.unitPrice.currency,
    customerId: write.customerId,
    resellerTierId: write.resellerTierId,
    panelId: write.panelId,
    enabled: write.enabled,
  };
}

/** Custom-service price rules, in PostgreSQL. Every query carries the tenant. */
export class DrizzleCustomServiceRuleRepository implements CustomServiceRuleRepository {
  constructor(private readonly db: Database) {}

  async list(scope: TenantContext, tx?: unknown): Promise<readonly CustomServiceRuleRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .select()
      .from(customServicePriceRules)
      .where(eq(customServicePriceRules.tenantId, tenantId))
      .orderBy(
        asc(customServicePriceRules.dimension),
        asc(customServicePriceRules.minUnits),
        asc(customServicePriceRules.id),
      )
      // One past the bound, so a tenant over it is visible to the caller rather than
      // silently truncated into a different selection.
      .limit(CUSTOM_SERVICE_MAX_RULES + 1);
    return rows.map(toRule);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<CustomServiceRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .select()
      .from(customServicePriceRules)
      .where(
        and(eq(customServicePriceRules.tenantId, tenantId), eq(customServicePriceRules.id, id)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRule(row);
  }

  async lockForWrite(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executor(this.db, tx).execute(
      sql`SELECT pg_advisory_xact_lock(${CUSTOM_SERVICE_RULES_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async lockForRead(scope: TenantContext, tx: unknown): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executor(this.db, tx).execute(
      sql`SELECT pg_advisory_xact_lock_shared(${CUSTOM_SERVICE_RULES_LOCK_CLASS}, hashtext(${tenantId}))`,
    );
  }

  async insert(
    scope: TenantContext,
    input: { readonly id: string; readonly write: CustomServiceRuleWrite; readonly now: Date },
    tx: unknown,
  ): Promise<CustomServiceRuleRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .insert(customServicePriceRules)
      .values({
        id: input.id,
        tenantId,
        ...ruleColumns(input.write),
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('custom_service_price_rules insert returned no row.');
    return toRule(row);
  }

  async update(
    scope: TenantContext,
    id: string,
    write: CustomServiceRuleWrite,
    now: Date,
    tx: unknown,
  ): Promise<CustomServiceRuleRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .update(customServicePriceRules)
      .set({ ...ruleColumns(write), updatedAt: now })
      .where(
        and(eq(customServicePriceRules.tenantId, tenantId), eq(customServicePriceRules.id, id)),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRule(row);
  }

  async delete(scope: TenantContext, id: string, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .delete(customServicePriceRules)
      .where(
        and(eq(customServicePriceRules.tenantId, tenantId), eq(customServicePriceRules.id, id)),
      )
      .returning({ id: customServicePriceRules.id });
    return rows.length > 0;
  }
}

/** Custom-service locations, joined to their panel's operator name. */
export class DrizzleCustomServiceLocationRepository implements CustomServiceLocationRepository {
  constructor(private readonly db: Database) {}

  private select(tx?: unknown) {
    return executor(this.db, tx)
      .select({
        panelId: customServiceLocations.panelId,
        panelName: panels.name,
        label: customServiceLocations.label,
        enabled: customServiceLocations.enabled,
        createdAt: customServiceLocations.createdAt,
        updatedAt: customServiceLocations.updatedAt,
      })
      .from(customServiceLocations)
      .innerJoin(
        panels,
        and(
          eq(panels.tenantId, customServiceLocations.tenantId),
          eq(panels.id, customServiceLocations.panelId),
        ),
      );
  }

  async list(scope: TenantContext, tx?: unknown): Promise<readonly CustomServiceLocationRecord[]> {
    const tenantId = requireTenantId(scope);
    return this.select(tx)
      .where(eq(customServiceLocations.tenantId, tenantId))
      .orderBy(asc(customServiceLocations.label), asc(customServiceLocations.panelId));
  }

  async find(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<CustomServiceLocationRecord | null> {
    const tenantId = requireTenantId(scope);
    const query = this.select(tx)
      .where(
        and(
          eq(customServiceLocations.tenantId, tenantId),
          eq(customServiceLocations.panelId, panelId),
        ),
      )
      .limit(1);
    // FOR SHARE inside a transaction: an operator disabling the location waits for the
    // draft or the confirmation reading it, and is then read by the next one.
    const rows =
      tx === undefined ? await query : await query.for('share', { of: customServiceLocations });
    return rows[0] ?? null;
  }

  async upsert(
    scope: TenantContext,
    input: {
      readonly panelId: string;
      readonly label: string;
      readonly enabled: boolean;
      readonly now: Date;
    },
    tx: unknown,
  ): Promise<{ readonly record: CustomServiceLocationRecord; readonly created: boolean }> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .insert(customServiceLocations)
      .values({
        tenantId,
        panelId: input.panelId,
        label: input.label,
        enabled: input.enabled,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [customServiceLocations.tenantId, customServiceLocations.panelId],
        set: { label: input.label, enabled: input.enabled, updatedAt: input.now },
      })
      // `xmax = 0` is PostgreSQL's own answer to "did this statement insert the row": an
      // updated row carries the updating transaction's id there.
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    const row = rows[0];
    if (row === undefined) throw new Error('custom_service_locations upsert returned no row.');
    const record = await this.find(scope, input.panelId, tx);
    if (record === null) throw new Error('custom_service_locations row vanished after upsert.');
    return { record, created: row.inserted };
  }

  async delete(scope: TenantContext, panelId: string, tx: unknown): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .delete(customServiceLocations)
      .where(
        and(
          eq(customServiceLocations.tenantId, tenantId),
          eq(customServiceLocations.panelId, panelId),
        ),
      )
      .returning({ panelId: customServiceLocations.panelId });
    return rows.length > 0;
  }
}

/** The frozen terms of each custom order. */
export class DrizzleOrderCustomServiceTermsRepository implements OrderCustomServiceTermsRepository {
  constructor(private readonly db: Database) {}

  async insert(
    scope: TenantContext,
    terms: OrderCustomServiceTerms,
    now: Date,
    tx: unknown,
  ): Promise<void> {
    const tenantId = requireTenantId(scope);
    await executor(this.db, tx).insert(orderCustomServiceTerms).values({
      tenantId,
      orderId: terms.orderId,
      panelId: terms.panelId,
      locationLabel: terms.locationLabel,
      volumeUnits: terms.volumeUnits,
      trafficBytes: terms.trafficBytes,
      durationDays: terms.durationDays,
      volumeRuleId: terms.volumeRuleId,
      volumeRuleLevel: terms.volumeRuleLevel,
      pricePerGbAmount: terms.pricePerGb.amountMinor,
      volumeAmount: terms.volumePrice.amountMinor,
      timeRuleId: terms.timeRuleId,
      timeRuleLevel: terms.timeRuleLevel,
      pricePerDayAmount: terms.pricePerDay.amountMinor,
      timeAmount: terms.timePrice.amountMinor,
      baseAmount: terms.basePrice.amountMinor,
      currency: terms.currency,
      createdAt: now,
    });
  }

  async findByOrder(
    scope: TenantContext,
    orderId: string,
    tx?: unknown,
  ): Promise<OrderCustomServiceTerms | null> {
    const tenantId = requireTenantId(scope);
    const rows = await executor(this.db, tx)
      .select()
      .from(orderCustomServiceTerms)
      .where(
        and(
          eq(orderCustomServiceTerms.tenantId, tenantId),
          eq(orderCustomServiceTerms.orderId, orderId),
        ),
      )
      .limit(1);
    const row = rows[0];
    if (row === undefined) return null;
    const currency = row.currency as CurrencyCode;
    return {
      orderId: row.orderId as OrderId,
      panelId: row.panelId,
      locationLabel: row.locationLabel,
      volumeUnits: row.volumeUnits,
      trafficBytes: row.trafficBytes,
      durationDays: row.durationDays,
      volumeRuleId: row.volumeRuleId,
      volumeRuleLevel: row.volumeRuleLevel as CustomServiceRuleLevel,
      pricePerGb: money(row.pricePerGbAmount, currency),
      volumePrice: money(row.volumeAmount, currency),
      timeRuleId: row.timeRuleId,
      timeRuleLevel: row.timeRuleLevel as CustomServiceRuleLevel,
      pricePerDay: money(row.pricePerDayAmount, currency),
      timePrice: money(row.timeAmount, currency),
      basePrice: money(row.baseAmount, currency),
      currency,
    };
  }
}
