import { and, count, desc, eq, isNotNull, ne, notInArray, or } from 'drizzle-orm';
import {
  OPERATION_TERMINAL_STATES,
  type ActorType,
  type BotInstanceId,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  orders,
  provisioningOperations,
  serviceCommercialActions,
  serviceOwnershipTransfers,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ServiceTransferDraft,
  ServiceTransferRecord,
  ServiceTransferRepository,
} from '../application/service-transfer-ports.js';

type Row = typeof serviceOwnershipTransfers.$inferSelect;

function toRecord(row: Row): ServiceTransferRecord {
  return {
    id: row.id,
    serviceId: row.serviceId,
    fromCustomerId: row.fromCustomerId as UserId,
    toCustomerId: row.toCustomerId as UserId,
    botInstanceId: row.botInstanceId as BotInstanceId | null,
    idempotencyKey: row.idempotencyKey,
    // Cast rather than re-validated: the CHECK is built from the contract's own enum.
    actorType: row.actorType as ActorType,
    actorLabel: row.actorLabel,
    correlationId: row.correlationId,
    createdAt: row.createdAt,
  };
}

/**
 * Package F — the append-only record of a service's changes of owner, and the three reads
 * a transfer re-decides under its locks.
 */
export class DrizzleServiceTransferRepository implements ServiceTransferRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async findByKey(
    scope: TenantContext,
    idempotencyKey: string,
    tx?: unknown,
  ): Promise<ServiceTransferRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceOwnershipTransfers)
      .where(
        and(
          eq(serviceOwnershipTransfers.tenantId, tenantId),
          eq(serviceOwnershipTransfers.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ServiceTransferRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceOwnershipTransfers)
      .where(
        and(eq(serviceOwnershipTransfers.tenantId, tenantId), eq(serviceOwnershipTransfers.id, id)),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async newestForService(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<ServiceTransferRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceOwnershipTransfers)
      .where(
        and(
          eq(serviceOwnershipTransfers.tenantId, tenantId),
          eq(serviceOwnershipTransfers.serviceId, serviceId),
        ),
      )
      // The row's sequence, exactly as `nexa_services_ownership_guard` orders them.
      .orderBy(desc(serviceOwnershipTransfers.seq))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async countForService(scope: TenantContext, serviceId: string, tx?: unknown): Promise<number> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ value: count() })
      .from(serviceOwnershipTransfers)
      .where(
        and(
          eq(serviceOwnershipTransfers.tenantId, tenantId),
          eq(serviceOwnershipTransfers.serviceId, serviceId),
        ),
      );
    return rows[0]?.value ?? 0;
  }

  async create(
    scope: TenantContext,
    draft: ServiceTransferDraft,
    tx: TransactionScope,
  ): Promise<ServiceTransferRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceOwnershipTransfers)
      .values({
        id: draft.id,
        tenantId,
        serviceId: draft.serviceId,
        fromCustomerId: draft.fromCustomerId,
        toCustomerId: draft.toCustomerId,
        botInstanceId: draft.botInstanceId,
        idempotencyKey: draft.idempotencyKey,
        actorType: draft.actorType,
        actorLabel: draft.actorLabel,
        correlationId: draft.correlationId,
        createdAt: draft.now,
      })
      .onConflictDoNothing({
        target: [serviceOwnershipTransfers.tenantId, serviceOwnershipTransfers.idempotencyKey],
      })
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async reassign(
    scope: TenantContext,
    input: {
      readonly serviceId: string;
      readonly fromCustomerId: UserId;
      readonly toCustomerId: UserId;
      readonly now: Date;
    },
    tx: TransactionScope,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(services)
      // The note is the sender's own words about their own service (brief F5): it does not
      // travel with the account.
      .set({ customerId: input.toCustomerId, customerNote: null, updatedAt: input.now })
      .where(
        and(
          eq(services.tenantId, tenantId),
          eq(services.id, input.serviceId),
          eq(services.customerId, input.fromCustomerId),
        ),
      )
      .returning({ id: services.id });
    return rows.length === 1;
  }

  async operationUndecided(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: provisioningOperations.id })
      .from(provisioningOperations)
      .where(
        and(
          eq(provisioningOperations.tenantId, tenantId),
          eq(provisioningOperations.serviceId, serviceId),
          notInArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),
          // Only a scheduled usage read is let through: nobody asked for it, and nobody is
          // told its outcome. Everything else, a customer's own usage read included, waits.
          or(
            ne(provisioningOperations.type, 'SYNC_USAGE'),
            isNotNull(provisioningOperations.requestedByCustomerId),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async commercialPaymentPending(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<boolean> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({ id: orders.id })
      .from(serviceCommercialActions)
      .innerJoin(
        orders,
        and(
          eq(orders.tenantId, serviceCommercialActions.tenantId),
          eq(orders.id, serviceCommercialActions.orderId),
        ),
      )
      .where(
        and(
          eq(serviceCommercialActions.tenantId, tenantId),
          eq(serviceCommercialActions.serviceId, serviceId),
          eq(orders.state, 'AWAITING_PAYMENT'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}
