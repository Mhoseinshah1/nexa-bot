import type {
  CurrencyCode,
  Money,
  OperationState,
  OrderId,
  PaymentId,
  RefundId,
  ServiceId,
  ServiceRefundRequestState,
  ServiceState,
  TenantContext,
  UserId,
} from '@nexa/contracts';

/** One customer service refund request (WP19), as the application layer holds it. */
export interface ServiceRefundRequestRecord {
  readonly id: string;
  readonly serviceId: ServiceId;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly paymentId: PaymentId;
  readonly botInstanceId: string;
  readonly state: ServiceRefundRequestState;
  readonly reason: string;
  /** The source payment's principal, snapshotted when the request was filed. */
  readonly principal: Money;
  readonly approvedAmount: Money | null;
  readonly refundId: RefundId | null;
  readonly operationId: string | null;
  readonly decidedByAdminId: string | null;
  readonly decidedAt: Date | null;
  readonly rejectionReason: string | null;
  readonly failureKind: string | null;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ServiceRefundRequestDraft {
  readonly id: string;
  readonly serviceId: ServiceId;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly paymentId: PaymentId;
  readonly botInstanceId: string;
  readonly reason: string;
  /** The filing's idempotency key: unique for ever, so a replay files nothing new. */
  readonly filingKey: string;
  readonly principalMinor: bigint;
  readonly currency: CurrencyCode;
  readonly now: Date;
}

/**
 * An EXECUTING request the sweep may decide: its deletion's operation state and the
 * service's state, read together so the decision is made on one observation.
 */
export interface ExecutingServiceRefundRequest {
  readonly request: ServiceRefundRequestRecord;
  readonly operationState: OperationState;
  readonly operationFailureKind: string | null;
  readonly serviceState: ServiceState;
  /** The reservation's state when the sweep read it: `REQUESTED` until something decides it. */
  readonly refundState: string;
}

/** A request as the Web Admin lists it: the row plus the few facts beside it. */
export interface ServiceRefundRequestListItem {
  readonly request: ServiceRefundRequestRecord;
  readonly serviceUsername: string | null;
  readonly customerTelegramUserId: string | null;
  readonly customerUsername: string | null;
  readonly operationState: OperationState | null;
}

export interface ServiceRefundRequestRepository {
  /**
   * Files a request. `null` when the service already has an OPEN or EXECUTING one — the
   * partial unique index answered, whatever the caller checked beforehand.
   */
  create(
    scope: TenantContext,
    draft: ServiceRefundRequestDraft,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  findById(
    scope: TenantContext,
    id: string,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  /** The same read, holding the row until the transaction ends. */
  findByIdForUpdate(
    scope: TenantContext,
    id: string,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  /** The service's OPEN or EXECUTING request, if it has one. */
  findActiveForService(
    scope: TenantContext,
    serviceId: ServiceId,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  /** The request a filing key filed, in any state. */
  findByFilingKey(
    scope: TenantContext,
    filingKey: string,
    tx?: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  list(
    scope: TenantContext,
    filter: {
      readonly state?: ServiceRefundRequestState;
      /** Any of these states, as one keyset stream (the attention queue, round 6). */
      readonly states?: readonly ServiceRefundRequestState[];
      readonly serviceId?: ServiceId;
      readonly limit: number;
      /** The keyset cursor: rows strictly older than this `(createdAt, id)`. */
      readonly before?: { readonly at: Date; readonly id: string };
    },
    tx?: unknown,
  ): Promise<readonly ServiceRefundRequestListItem[]>;

  /** `OPEN -> EXECUTING`, conditional. `null` when the row was not OPEN. */
  approve(
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
  ): Promise<ServiceRefundRequestRecord | null>;

  /** `OPEN -> REJECTED`, conditional. `null` when the row was not OPEN. */
  reject(
    scope: TenantContext,
    id: string,
    input: { readonly reason: string; readonly adminId: string },
    now: Date,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  /** `EXECUTING -> COMPLETED | FAILED`, conditional. `null` when the row was not EXECUTING. */
  resolveExecution(
    scope: TenantContext,
    id: string,
    input: { readonly to: 'COMPLETED' | 'FAILED'; readonly failureKind: string | null },
    now: Date,
    tx: unknown,
  ): Promise<ServiceRefundRequestRecord | null>;

  /**
   * EXECUTING requests the sweep can decide, oldest first. A request whose operation is
   * still PLANNED or IN_FLIGHT (or UNKNOWN) is not returned: nothing about it can be decided
   * yet. Nor is one the sweep would only leave standing — a SUCCEEDED deletion whose service
   * did not move, or a reservation no longer REQUESTED (or released, after a failure) — so
   * such rows can never fill a batch ahead of the ones that can move.
   */
  executingDecidable(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ExecutingServiceRefundRequest[]>;

  /**
   * Whether some TERMINATE of this service is undecided — PLANNED, IN_FLIGHT or UNKNOWN. The
   * sweep's in-transaction check, and the same predicate `executingDecidable` filters on.
   */
  terminationUndecided(scope: TenantContext, serviceId: string, tx?: unknown): Promise<boolean>;
}
