import { and, asc, eq, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type {
  OrderId,
  PanelId,
  ProductId,
  ServiceDeliveryState,
  ServiceState,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import { services } from '../../../../infrastructure/persistence/schema.js';
import type {
  ProvisionOutcome,
  ServiceCursor,
  ServiceDraft,
  ServicePage,
  ServiceRecord,
  ServiceRepository,
  ServiceSearch,
} from '../application/ports.js';

type Row = typeof services.$inferSelect;

function toRecord(row: Row): ServiceRecord {
  return {
    id: row.id,
    tenantId: row.tenantId,
    customerId: row.customerId as UserId,
    orderId: row.orderId as OrderId,
    panelId: row.panelId as PanelId,
    productId: row.productId as ProductId,
    state: row.state as ServiceState,
    providerUsername: row.providerUsername,
    providerUserId: row.providerUserId,
    subscriptionUrl: row.subscriptionUrl,
    expiresAt: row.expiresAt,
    trafficLimitBytes: row.trafficLimitBytes,
    trafficUsedBytes: row.trafficUsedBytes,
    usageSyncedAt: row.usageSyncedAt,
    deliveryState: row.deliveryState as ServiceDeliveryState,
    deliveryAttempts: row.deliveryAttempts,
    deliveredAt: row.deliveredAt,
    deliveryNextAttemptAt: row.deliveryNextAttemptAt,
    provisionedAt: row.provisionedAt,
    terminatedAt: row.terminatedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Services, in PostgreSQL.
 *
 * Every query carries `eq(services.tenantId, …)`, primary-key lookups included, for
 * the reason every other repository here states: a lookup without the tenant returns
 * another tenant's row and leaves the caller holding something it should never have
 * seen. On this table that row is a subscription URL, which is a bearer capability.
 */
export class DrizzleServiceRepository implements ServiceRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  /**
   * Writes the service a settled order produced, or reports that one already exists.
   *
   * `ON CONFLICT DO NOTHING` against `services_tenant_order_key`, and a null return
   * when it fired. Losing is a NORMAL outcome of a correct system — a replayed
   * settlement, a second replica, a double-tapped button — so it is reported as a
   * value rather than thrown. The caller reads the winner's row; nothing here decides
   * which of them was first, because nothing needs to.
   */
  async create(
    scope: TenantContext,
    draft: ServiceDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(services)
      .values({
        id: draft.id,
        tenantId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        panelId: draft.panelId,
        productId: draft.productId,
        state: 'PENDING_PROVISION',
        providerUsername: draft.providerUsername,
        trafficLimitBytes: draft.trafficLimitBytes,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findById(scope: TenantContext, id: string, tx?: unknown): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<ServiceRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.orderId, orderId)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    search: ServiceSearch,
    limit: number,
    cursor: ServiceCursor | null,
    tx?: unknown,
  ): Promise<ServicePage> {
    const tenantId = requireTenantId(scope);
    const filters: SQL[] = [eq(services.tenantId, tenantId)];
    if (search.customerId !== undefined) filters.push(eq(services.customerId, search.customerId));
    if (search.panelId !== undefined) filters.push(eq(services.panelId, search.panelId));
    if (search.state !== undefined) filters.push(eq(services.state, search.state));
    if (search.deliveryState !== undefined) {
      filters.push(eq(services.deliveryState, search.deliveryState));
    }
    if (cursor !== null) {
      /*
       * Keyset, on `(created_at, id)`.
       *
       * The same shape `/panels` and `/users` already use, and for the same reason:
       * `created_at` alone is not unique, so an offset would skip or repeat a row
       * whenever two services were created in the same millisecond — which is exactly
       * what a batch settlement produces.
       */
      filters.push(
        sql`(${services.createdAt}, ${services.id}) > (${cursor.createdAt}, ${cursor.id})`,
      );
    }
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(and(...filters))
      .orderBy(asc(services.createdAt), asc(services.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit).map(toRecord);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : null,
    };
  }

  /**
   * Moves a service between two states, and reports whether the row moved.
   *
   * The outcome fields are written by the SAME statement as the state, because
   * `services_provisioned_at_check` binds them: `(state = 'PENDING_PROVISION' OR
   * state = 'UNRECONCILED') = (provisioned_at IS NULL)`. A transition that set the
   * state alone would be refused by the database, which is the point of the
   * constraint and the reason this takes a struct rather than exposing setters.
   */
  async transition(
    scope: TenantContext,
    id: string,
    from: ServiceState,
    to: ServiceState,
    outcome: ProvisionOutcome | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const becomingLive = to === 'ACTIVE';
    const rows = await this.exec(tx)
      .update(services)
      .set({
        state: to,
        ...(outcome === null
          ? {}
          : {
              providerUserId: outcome.providerUserId,
              subscriptionUrl: outcome.subscriptionUrl,
              expiresAt: outcome.expiresAt,
              ...(outcome.trafficUsedBytes === null
                ? {}
                : { trafficUsedBytes: outcome.trafficUsedBytes }),
              ...(outcome.usageSyncedAt === null ? {} : { usageSyncedAt: outcome.usageSyncedAt }),
            }),
        // The constraint's two halves, both written here so neither can be forgotten.
        ...(becomingLive ? { provisionedAt: now } : {}),
        ...(to === 'TERMINATED' ? { terminatedAt: now } : {}),
        updatedAt: now,
      })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), eq(services.state, from)))
      .returning({ id: services.id });
    return rows.length > 0;
  }

  /**
   * Records what a delivery attempt did, conditionally on the state it was tried from.
   *
   * The attempt counter advances in the same statement, by SQL rather than by a value
   * the caller computed: two workers that both read `2` and both wrote `3` would leave
   * a service one attempt short of the ceiling for ever.
   */
  async recordDelivery(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    to: ServiceDeliveryState,
    stamps: { readonly deliveredAt: Date | null; readonly nextAttemptAt: Date | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(services)
      .set({
        deliveryState: to,
        deliveryAttempts: sql`${services.deliveryAttempts} + 1`,
        deliveredAt: stamps.deliveredAt,
        deliveryNextAttemptAt: stamps.nextAttemptAt,
        updatedAt: now,
      })
      .where(
        and(eq(services.tenantId, tenantId), eq(services.id, id), eq(services.deliveryState, from)),
      )
      .returning({ id: services.id });
    return rows.length > 0;
  }

  /**
   * Services whose announcement is due.
   *
   * `PENDING` only — `DELIVERY_AUTO_RETRY_STATES` is that one value, and the other
   * three are deliberately never swept: `DELIVERED` is done, and `UNCONFIRMED` and
   * `FAILED` both need a person, for reasons `provisioning.ts` records.
   *
   * Only ACTIVE services, because a service that has no provider account yet has
   * nothing to announce, and announcing one would be the false success this codebase
   * exists to end.
   */
  async claimDeliveryDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(services)
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.deliveryState, 'PENDING'),
          eq(services.state, 'ACTIVE'),
          or(isNull(services.deliveryNextAttemptAt), lte(services.deliveryNextAttemptAt, now)),
        ),
      )
      .orderBy(asc(services.createdAt), asc(services.id))
      .limit(limit);
    return rows.map(toRecord);
  }
}
