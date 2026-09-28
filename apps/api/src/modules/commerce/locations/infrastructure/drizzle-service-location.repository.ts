import { and, asc, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';
import { money } from '@nexa/contracts';
import type {
  CurrencyCode,
  OrderId,
  PanelId,
  ProductId,
  ServiceLocationId,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import {
  orders,
  provisioningOperations,
  serviceCommercialActions,
  serviceLocationChanges,
  serviceLocations,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  LocationChangeDraft,
  LocationChangeRecord,
  LocationChangeRepository,
  ServiceLocationConflict,
  ServiceLocationDraft,
  ServiceLocationRecord,
  ServiceLocationRepository,
} from '../application/ports.js';

/**
 * The operator's locations and the customers' change requests, in PostgreSQL (WP-A6).
 *
 * Every query carries the tenant, the primary-key lookups included, for the reason every
 * repository here states: a lookup by id alone returns another tenant's row.
 */
export class DrizzleServiceLocationRepository implements ServiceLocationRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async list(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceLocationRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocations)
      .where(eq(serviceLocations.tenantId, tenantId))
      .orderBy(
        asc(serviceLocations.panelId),
        asc(serviceLocations.sortOrder),
        asc(serviceLocations.label),
        asc(serviceLocations.id),
      )
      .limit(limit);
    return rows.map(toLocation);
  }

  async findById(
    scope: TenantContext,
    id: ServiceLocationId,
    tx?: unknown,
  ): Promise<ServiceLocationRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocations)
      .where(and(eq(serviceLocations.tenantId, tenantId), eq(serviceLocations.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toLocation(row);
  }

  async forPanel(
    scope: TenantContext,
    panelId: string,
    tx?: unknown,
  ): Promise<readonly ServiceLocationRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocations)
      .where(and(eq(serviceLocations.tenantId, tenantId), eq(serviceLocations.panelId, panelId)))
      .orderBy(
        asc(serviceLocations.sortOrder),
        asc(serviceLocations.label),
        asc(serviceLocations.id),
      );
    return rows.map(toLocation);
  }

  async create(
    scope: TenantContext,
    input: {
      readonly id: ServiceLocationId;
      readonly draft: ServiceLocationDraft;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<
    | { readonly ok: true; readonly record: ServiceLocationRecord }
    | { readonly ok: false; readonly conflict: ServiceLocationConflict }
  > {
    const tenantId = requireTenantId(scope);
    try {
      const rows = await this.exec(tx)
        .insert(serviceLocations)
        .values({
          id: input.id,
          tenantId,
          ...columnsFor(input.draft),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
      const row = rows[0];
      if (row === undefined) throw new Error('service_locations insert returned no row.');
      return { ok: true, record: toLocation(row) };
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict === null) throw error;
      // The transaction is aborted; the caller throws the named refusal and rolls back.
      return { ok: false, conflict };
    }
  }

  async update(
    scope: TenantContext,
    id: ServiceLocationId,
    draft: ServiceLocationDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<
    | { readonly ok: true; readonly record: ServiceLocationRecord | null }
    | { readonly ok: false; readonly conflict: ServiceLocationConflict }
  > {
    const tenantId = requireTenantId(scope);
    try {
      const rows = await this.exec(tx)
        .update(serviceLocations)
        // Every edit is a new version: a change request names the one it was quoted from.
        .set({
          ...columnsFor(draft),
          version: sql`${serviceLocations.version} + 1`,
          updatedAt: now,
        })
        .where(and(eq(serviceLocations.tenantId, tenantId), eq(serviceLocations.id, id)))
        .returning();
      const row = rows[0];
      return { ok: true, record: row === undefined ? null : toLocation(row) };
    } catch (error) {
      const conflict = conflictOf(error);
      if (conflict === null) throw error;
      return { ok: false, conflict };
    }
  }

  async delete(
    scope: TenantContext,
    id: ServiceLocationId,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .delete(serviceLocations)
      .where(and(eq(serviceLocations.tenantId, tenantId), eq(serviceLocations.id, id)))
      .returning({ id: serviceLocations.id });
    return rows.length === 1;
  }

  async isReferenced(
    scope: TenantContext,
    id: ServiceLocationId,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const changes = await this.exec(tx)
      .select({ id: serviceLocationChanges.id })
      .from(serviceLocationChanges)
      .where(
        and(
          eq(serviceLocationChanges.tenantId, tenantId),
          eq(serviceLocationChanges.locationId, id),
        ),
      )
      .limit(1);
    if (changes.length > 0) return true;
    const actions = await this.exec(tx)
      .select({ id: serviceCommercialActions.id })
      .from(serviceCommercialActions)
      .where(
        and(
          eq(serviceCommercialActions.tenantId, tenantId),
          eq(serviceCommercialActions.locationId, id),
        ),
      )
      .limit(1);
    return actions.length > 0;
  }
}

export class DrizzleLocationChangeRepository implements LocationChangeRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    draft: LocationChangeDraft,
    tx: TransactionScope,
  ): Promise<LocationChangeRecord> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceLocationChanges)
      .values({
        id: draft.id,
        tenantId,
        serviceId: draft.serviceId,
        customerId: draft.customerId,
        locationId: draft.locationId,
        locationVersion: draft.locationVersion,
        fromLocationKey: draft.fromLocationKey,
        fromLocationLabel: draft.fromLocationLabel,
        toLocationKey: draft.toLocationKey,
        toLocationLabel: draft.toLocationLabel,
        priceAmount: draft.price.amountMinor,
        priceCurrency: draft.price.currency,
        orderId: draft.orderId,
        operationId: draft.operationId,
        createdAt: draft.now,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error('service_location_changes insert returned no row.');
    return toChange(row);
  }

  async findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<LocationChangeRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocationChanges)
      .where(
        and(
          eq(serviceLocationChanges.tenantId, tenantId),
          eq(serviceLocationChanges.orderId, orderId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toChange(row);
  }

  async findForOperation(
    scope: TenantContext,
    operation: { readonly id: string; readonly orderId: OrderId | null },
    tx?: unknown,
  ): Promise<LocationChangeRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocationChanges)
      .where(
        and(
          eq(serviceLocationChanges.tenantId, tenantId),
          operation.orderId === null
            ? eq(serviceLocationChanges.operationId, operation.id)
            : eq(serviceLocationChanges.orderId, operation.orderId),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toChange(row);
  }

  async countedRequestTimes(
    scope: TenantContext,
    serviceId: string,
    excludeOrderId: OrderId | null,
    tx?: unknown,
  ): Promise<readonly Date[]> {
    const tenantId = requireTenantId(scope);
    /*
     * A paid change's operation is the order's `CHANGE_LOCATION`; a free change's is the
     * one it names. Both joins are LEFT: a paid change has no operation until it settles.
     */
    const rows = await this.exec(tx)
      .select({ createdAt: serviceLocationChanges.createdAt })
      .from(serviceLocationChanges)
      .leftJoin(
        orders,
        and(
          eq(orders.tenantId, serviceLocationChanges.tenantId),
          eq(orders.id, serviceLocationChanges.orderId),
        ),
      )
      .leftJoin(
        provisioningOperations,
        and(
          eq(provisioningOperations.tenantId, serviceLocationChanges.tenantId),
          eq(provisioningOperations.type, 'CHANGE_LOCATION'),
          or(
            eq(provisioningOperations.id, serviceLocationChanges.operationId),
            eq(provisioningOperations.orderId, serviceLocationChanges.orderId),
          ),
        ),
      )
      .where(
        and(
          eq(serviceLocationChanges.tenantId, tenantId),
          eq(serviceLocationChanges.serviceId, serviceId),
          ...(excludeOrderId === null
            ? []
            : [
                or(
                  isNull(serviceLocationChanges.orderId),
                  sql`${serviceLocationChanges.orderId} <> ${excludeOrderId}`,
                ),
              ]),
          or(
            // Paid, and money is owed or taken: it counts whatever its operation says yet.
            inArray(orders.state, ['AWAITING_PAYMENT', 'PAID']),
            // Paid and given back, but the account DID move (or may have): still counts.
            and(
              eq(orders.state, 'REFUNDED'),
              inArray(provisioningOperations.state, ['SUCCEEDED', 'UNKNOWN']),
            ),
            // Free: counts unless the move provably did not happen.
            and(
              isNull(serviceLocationChanges.orderId),
              notInArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),
            ),
          ),
        ),
      )
      .orderBy(desc(serviceLocationChanges.createdAt));
    return rows.map((row) => row.createdAt);
  }

  async listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly LocationChangeRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceLocationChanges)
      .where(
        and(
          eq(serviceLocationChanges.tenantId, tenantId),
          eq(serviceLocationChanges.serviceId, serviceId),
        ),
      )
      .orderBy(desc(serviceLocationChanges.createdAt), desc(serviceLocationChanges.id))
      .limit(limit);
    return rows.map(toChange);
  }
}

/** The draft's columns, one place, so create and update agree. */
function columnsFor(draft: ServiceLocationDraft) {
  return {
    panelId: draft.panelId,
    productId: draft.productId,
    locationKey: draft.locationKey,
    label: draft.label,
    isInitial: draft.initial,
    enabled: draft.enabled,
    // Both halves of the price, or both null, from ONE nullable value.
    priceAmount: draft.price === null ? null : draft.price.amountMinor,
    priceCurrency: draft.price === null ? null : draft.price.currency,
    cooldownHours: draft.limits.cooldownHours,
    maxChanges: draft.limits.maxChanges,
    periodDays: draft.limits.periodDays,
    sortOrder: draft.sortOrder,
  };
}

/** Which named unique rule a write lost on, or null for any other error. */
function conflictOf(error: unknown): ServiceLocationConflict | null {
  if (isUniqueViolation(error, 'service_locations_key')) return 'DUPLICATE_KEY';
  if (isUniqueViolation(error, 'service_locations_initial_key')) return 'SECOND_INITIAL';
  return null;
}

function toLocation(row: typeof serviceLocations.$inferSelect): ServiceLocationRecord {
  return {
    id: row.id as ServiceLocationId,
    tenantId: row.tenantId,
    panelId: row.panelId as PanelId,
    productId: row.productId as ProductId | null,
    locationKey: row.locationKey,
    label: row.label,
    initial: row.isInitial,
    enabled: row.enabled,
    price:
      row.priceAmount === null || row.priceCurrency === null
        ? null
        : money(row.priceAmount, row.priceCurrency as CurrencyCode),
    limits: {
      cooldownHours: row.cooldownHours,
      maxChanges: row.maxChanges,
      periodDays: row.periodDays,
    },
    sortOrder: row.sortOrder,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toChange(row: typeof serviceLocationChanges.$inferSelect): LocationChangeRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    serviceId: row.serviceId,
    customerId: row.customerId as UserId,
    locationId: row.locationId as ServiceLocationId,
    locationVersion: row.locationVersion,
    fromLocationKey: row.fromLocationKey,
    fromLocationLabel: row.fromLocationLabel,
    toLocationKey: row.toLocationKey,
    toLocationLabel: row.toLocationLabel,
    price: money(row.priceAmount, row.priceCurrency as CurrencyCode),
    orderId: row.orderId as OrderId | null,
    operationId: row.operationId,
    createdAt: row.createdAt,
  };
}
