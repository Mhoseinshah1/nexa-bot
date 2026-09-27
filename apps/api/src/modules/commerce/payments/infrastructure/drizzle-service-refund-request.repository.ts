import { and, asc, desc, eq, inArray, notInArray, or, sql } from 'drizzle-orm';
import {
  OPERATION_TERMINAL_STATES,
  TARGETED_OPERATION_TYPES,
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
  refunds,
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
        filingKey: draft.filingKey,
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

  async findByFilingKey(
    scope: TenantContext,
    filingKey: string,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null> {
    const tenantId = requireTenantId(scope);
    const rows = await this.exec(tx)
      .select()
      .from(serviceRefundRequests)
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.filingKey, filingKey),
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
      readonly states?: readonly ServiceRefundRequestState[];
      readonly serviceId?: ServiceId;
      readonly limit: number;
      readonly before?: { readonly at: Date; readonly id: string };
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
          filter.states === undefined
            ? undefined
            : inArray(serviceRefundRequests.state, [...filter.states]),
          filter.serviceId === undefined
            ? undefined
            : eq(serviceRefundRequests.serviceId, filter.serviceId),
          // The keyset, newest first: strictly older than the last row shown, the id
          // breaking a tie between rows written in one transaction.
          filter.before === undefined
            ? undefined
            : sql`(${serviceRefundRequests.createdAt}, ${serviceRefundRequests.id}) < (${filter.before.at.toISOString()}::timestamptz, ${filter.before.id}::uuid)`,
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

  async commercialUndecided(
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
          inArray(provisioningOperations.type, [...TARGETED_OPERATION_TYPES]),
          notInArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  async terminationUndecided(
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
          eq(provisioningOperations.type, 'TERMINATE'),
          notInArray(provisioningOperations.state, [...OPERATION_TERMINAL_STATES]),
        ),
      )
      .limit(1);
    return rows.length > 0;
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
        refundState: refunds.state,
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
      .innerJoin(
        refunds,
        and(
          eq(refunds.tenantId, serviceRefundRequests.tenantId),
          eq(refunds.id, serviceRefundRequests.refundId),
        ),
      )
      .where(
        and(
          eq(serviceRefundRequests.tenantId, tenantId),
          eq(serviceRefundRequests.state, 'EXECUTING'),
          /*
           * Only a row the sweep can decide. A deletion that SUCCEEDED counts only once the
           * service moved and while the reservation is still REQUESTED; one that failed,
           * only while the reservation is REQUESTED or already released. Anything else — a
           * service that did not move, a reservation another release closed by hand — is
           * left EXECUTING for an operator, and so is never returned: returned, it would be
           * refused again on every tick and, oldest first, fill every batch until the
           * refunds behind it were never decided at all.
           */
          or(
            /*
             * Removed: the service is gone and the reservation still held. Credited whatever
             * this request's own deletion says (Codex review of #83, round 12): an UNKNOWN
             * deletion is never terminal, and an operator's retry beside it can succeed. The
             * service ending proves the account was removed, and the sweep's own decision
             * credits a removed service without asking the request's operation. Required to
             * be SUCCEEDED here, the row was never returned: the customer lost the service
             * and the approved credit stayed reserved for ever.
             */
            and(eq(services.state, 'TERMINATED'), eq(refunds.state, 'REQUESTED')),
            and(
              or(
                and(
                  inArray(provisioningOperations.state, ['FAILED', 'ABANDONED']),
                  inArray(refunds.state, ['REQUESTED', 'FAILED']),
                ),
                /*
                 * A reservation another release already closed (FAILED) holds no money, so
                 * its request is decided FAILED once its own deletion has ended — a success
                 * included, when the service is gone (Codex review of #83, round 7). Left
                 * out, it stayed EXECUTING for ever.
                 */
                and(
                  eq(provisioningOperations.state, 'SUCCEEDED'),
                  eq(services.state, 'TERMINATED'),
                  eq(refunds.state, 'FAILED'),
                ),
              ),
              /*
               * Nor, unless it is completing, while another deletion of the service is
               * undecided — PLANNED, IN_FLIGHT or UNKNOWN (Codex review of #83, rounds 6 and
               * 7): the sweep waits for that answer rather than releasing, so a row it would
               * only refuse again is never returned. The sweep's own check is
               * `terminationUndecided`, the same predicate.
               */
              or(
                and(eq(services.state, 'TERMINATED'), eq(refunds.state, 'REQUESTED')),
                sql`not ${undecidedTermination()}`,
              ),
            ),
          ),
        ),
      )
      .orderBy(asc(serviceRefundRequests.createdAt), asc(serviceRefundRequests.id))
      .limit(Math.max(1, limit));
    return rows.map((row) => ({
      request: toRecord(row.request),
      operationState: row.operationState as OperationState,
      operationFailureKind: row.operationFailureKind,
      serviceState: row.serviceState as ServiceState,
      refundState: row.refundState,
    }));
  }
}

/**
 * Some TERMINATE of the request's service is undecided: anything but SUCCEEDED, FAILED or
 * ABANDONED. UNKNOWN is undecided — the account may already be gone, or may yet be — and so
 * is waited for, never released past (Codex review of #83, round 7).
 */
function undecidedTermination() {
  return sql`exists (select 1 from ${provisioningOperations} other_op
    where other_op.tenant_id = ${serviceRefundRequests.tenantId}
      and other_op.service_id = ${serviceRefundRequests.serviceId}
      and other_op.type = 'TERMINATE'
      and other_op.state not in (${sql.join(
        OPERATION_TERMINAL_STATES.map((state) => sql`${state}`),
        sql`, `,
      )}))`;
}
