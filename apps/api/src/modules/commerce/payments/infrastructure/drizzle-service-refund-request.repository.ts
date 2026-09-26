import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  OPERATION_TERMINAL_STATES,
  SERVICE_REFUND_REQUEST_ACTIVE_STATES,
  money,
  type CurrencyCode,
  type OperationState,
  type OrderId,
  type PaymentId,
  type RefundId,
  type ServiceId,
  type ServiceRefundRequestState,
  type ServiceState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { Database, Executor } from '../../../../infrastructure/persistence/database.js';
import {
  requireTenantId,
  type TransactionScope,
} from '../../../../infrastructure/persistence/unit-of-work.js';
import {
  customers,
  provisioningOperations,
  serviceRefundRequests,
  services,
} from '../../../../infrastructure/persistence/schema.js';
import type {
  ExecutingServiceRefundRequest,
  ServiceRefundRequestDraft,
  ServiceRefundRequestListItem,
  ServiceRefundRequestRecord,
  ServiceRefundRequestRepository,
} from '../application/service-refund-request-ports.js';

type Row = typeof serviceRefundRequests.$inferSelect;

function toRecord(row: Row): ServiceRefundRequestRecord {
  const currency = row.currency as CurrencyCode;
  return {
    id: row.id,
    serviceId: row.serviceId as ServiceId,
    customerId: row.customerId as UserId,
    orderId: row.orderId as OrderId,
    paymentId: row.paymentId as PaymentId,
    botInstanceId: row.botInstanceId,
    // Cast rather than re-validated: the CHECK is built from the contract's own enum.
    state: row.state as ServiceRefundRequestState,
    reason: row.reason,
    principal: money(row.principalMinor, currency),
    approvedAmount:
      row.approvedAmountMinor === null ? null : money(row.approvedAmountMinor, currency),
    refundId: row.refundId === null ? null : (row.refundId as RefundId),
    operationId: row.operationId,
    decidedByAdminId: row.decidedByAdminId,
    decidedAt: row.decidedAt,
    rejectionReason: row.rejectionReason,
    failureKind: row.failureKind,
    resolvedAt: row.resolvedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * WP19 — the customer service refund requests. Every state change is a conditional UPDATE
 * naming its `from`; there is no setter.
 */
export class DrizzleServiceRefundRequestRepository implements ServiceRefundRequestRepository {
  constructor(private readonly db: Database) {}

  private exec(tx?: unknown): Executor {
    return (tx as TransactionScope | undefined)?.tx ?? this.db;
  }

  async create(
    scope: TenantContext,
    draft: ServiceRefundRequestDraft,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .insert(serviceRefundRequests)
      .values({
        id: draft.id,
        tenantId,
        serviceId: draft.serviceId,
        customerId: draft.customerId,
        orderId: draft.orderId,
        paymentId: draft.paymentId,
        botInstanceId: draft.botInstanceId,
        state: 'OPEN',
        reason: draft.reason,
        principalMinor: draft.principalMinor,
        currency: draft.currency,
        createdAt: draft.now,
        updatedAt: draft.now,
      })
      /*
       * The partial unique index over OPEN and EXECUTING is the arbiter: a second filing
       * for the same service — a double tap, a replayed update, a concurrent request —
       * inserts nothing, and the caller answers with the request that already stands.
       */
      .onConflictDoNothing({
        target: [serviceRefundRequests.tenantId, serviceRefundRequests.serviceId],
        where: sql`state IN ('OPEN', 'EXECUTING')`,
      })
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceRefundRequests)
      .where(and(eq(serviceRefundRequests.tenantId, tenantId), eq(serviceRefundRequests.id, id)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findByIdForUpdate(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceRefundRequests)
      .where(and(eq(serviceRefundRequests.tenantId, tenantId), eq(serviceRefundRequests.id, id)))
      .limit(1)
      .for('update');
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async findActiveForService(
    scope: TenantContext,
    serviceId: ServiceId,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceRefundRequests)
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.serviceId, serviceId),
          inArray(serviceRefundRequests.state, [...SERVICE_REFUND_REQUEST_ACTIVE_STATES]),
        ),
      )
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async list(
    scope: TenantContext,
    filter: {
      readonly state?: ServiceRefundRequestState;
      readonly serviceId?: ServiceId;
      readonly limit: number;
    },
    tx?: unknown,
  ): Promise<readonly ServiceRefundRequestListItem[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        request: serviceRefundRequests,
        serviceUsername: services.providerUsername,
        customerTelegramUserId: customers.telegramUserId,
        customerUsername: customers.username,
        operationState: provisioningOperations.state,
      })
      .from(serviceRefundRequests)
      .leftJoin(
        services,
        and(
          eq(services.tenantId, serviceRefundRequests.tenantId),
          eq(services.id, serviceRefundRequests.serviceId),
        ),
      )
      .leftJoin(
        customers,
        and(
          eq(customers.tenantId, serviceRefundRequests.tenantId),
          eq(customers.id, serviceRefundRequests.customerId),
        ),
      )
      .leftJoin(
        provisioningOperations,
        and(
          eq(provisioningOperations.tenantId, serviceRefundRequests.tenantId),
          eq(provisioningOperations.id, serviceRefundRequests.operationId),
        ),
      )
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          filter.state === undefined ? undefined : eq(serviceRefundRequests.state, filter.state),
          filter.serviceId === undefined
            ? undefined
            : eq(serviceRefundRequests.serviceId, filter.serviceId),
        ),
      )
      .orderBy(desc(serviceRefundRequests.createdAt), desc(serviceRefundRequests.id))
      .limit(Math.max(1, filter.limit));
    return rows.map((row) => ({
      request: toRecord(row.request),
      serviceUsername: row.serviceUsername,
      customerTelegramUserId: row.customerTelegramUserId,
      customerUsername: row.customerUsername,
      operationState: row.operationState === null ? null : (row.operationState as OperationState),
    }));
  }

  async approve(
    scope: TenantContext,
    id: string,
    input: {
      readonly amountMinor: bigint;
      readonly refundId: RefundId;
      readonly operationId: string;
      readonly adminId: string;
    },
    now: Date,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(serviceRefundRequests)
      .set({
        state: 'EXECUTING',
        approvedAmountMinor: input.amountMinor,
        refundId: input.refundId,
        operationId: input.operationId,
        decidedByAdminId: input.adminId,
        decidedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'OPEN'),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async reject(
    scope: TenantContext,
    id: string,
    input: { readonly reason: string; readonly adminId: string },
    now: Date,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(serviceRefundRequests)
      .set({
        state: 'REJECTED',
        rejectionReason: input.reason,
        decidedByAdminId: input.adminId,
        decidedAt: now,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'OPEN'),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async resolveExecution(
    scope: TenantContext,
    id: string,
    input: { readonly to: 'COMPLETED' | 'FAILED'; readonly failureKind: string | null },
    now: Date,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .update(serviceRefundRequests)
      .set({
        state: input.to,
        failureKind: input.failureKind,
        resolvedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.id, id),
          eq(serviceRefundRequests.state, 'EXECUTING'),
        ),
      )
      .returning();
    const row = rows[0];
    return row === undefined ? null : toRecord(row);
  }

  async executingDecidable(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ExecutingServiceRefundRequest[]> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select({
        request: serviceRefundRequests,
        operationState: provisioningOperations.state,
        operationFailureKind: provisioningOperations.failureKind,
        serviceState: services.state,
      })
      .from(serviceRefundRequests)
      .innerJoin(
        provisioningOperations,
        and(
          eq(provisioningOperations.tenantId, serviceRefundRequests.tenantId),
          eq(provisioningOperations.id, serviceRefundRequests.operationId),
        ),
      )
      .innerJoin(
        services,
        and(
          eq(services.tenantId, serviceRefundRequests.tenantId),
          eq(services.id, serviceRefundRequests.serviceId),
        ),
      )
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.state, 'EXECUTING'),
          inArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),
        ),
      )
      .orderBy(asc(serviceRefundRequests.createdAt), asc(serviceRefundRequests.id))
      .limit(Math.max(1, limit));
    return rows.map((row) => ({
      request: toRecord(row.request),
      operationState: row.operationState as OperationState,
      operationFailureKind: row.operationFailureKind,
      serviceState: row.serviceState as ServiceState,
    }));
  }
}
