import type {
  BotInstanceId,
  OperationId,
  OperationState,
  OperationType,
  OrderId,
  PanelActivation,
  PanelId,
  ProductId,
  ProductSpecification,
  ProviderFailureKind,
  ServiceDeliveryState,
  ServiceState,
  TenantContext,
  UserId,
} from '@nexa/contracts';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * A service, as the application layer sees it.
 *
 * The canonical record of what a customer is entitled to. It outlives every order: a
 * renewal is a NEW order and a NEW operation against this same row, which is why
 * `orderId` is named `orderId` and not `lastOrderId` — it is the order that CREATED
 * it, and nothing rewrites it.
 *
 * `providerUsername` is derived from `id` and stored anyway. Stored because the unique
 * index `services_panel_provider_username_key` is what makes two services claiming one
 * provider account impossible, and an index cannot be built over a function call.
 * Derived because that is what lets a reconcile ask for it after a write was lost.
 */
export interface ServiceRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly panelId: PanelId;
  readonly productId: ProductId;
  readonly state: ServiceState;
  readonly providerUsername: string;
  readonly providerUserId: string | null;
  readonly subscriptionUrl: string | null;
  readonly expiresAt: Date | null;
  /** Zero means unlimited, matching the product snapshot it came from. */
  readonly trafficLimitBytes: bigint;
  readonly trafficUsedBytes: bigint;
  readonly usageSyncedAt: Date | null;
  readonly deliveryState: ServiceDeliveryState;
  readonly deliveryAttempts: number;
  readonly deliveredAt: Date | null;
  readonly deliveryNextAttemptAt: Date | null;
  readonly provisionedAt: Date | null;
  readonly terminatedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Everything needed to write the service row that a settled order produces.
 *
 * Every field is decided by the caller INSIDE the settling transaction, from the
 * order's own snapshot. Nothing here is read back from a product: the product may
 * since have been renamed, re-priced or re-specified, and `commerce.ts` records that
 * a report which joins on today's product row is how «محصول حذف‌شده» happens.
 */
export interface ServiceDraft {
  readonly id: string;
  readonly customerId: UserId;
  readonly orderId: OrderId;
  readonly panelId: PanelId;
  readonly productId: ProductId;
  readonly providerUsername: string;
  readonly trafficLimitBytes: bigint;
}

export interface ServiceCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface ServicePage {
  readonly items: readonly ServiceRecord[];
  readonly nextCursor: ServiceCursor | null;
}

export interface ServiceSearch {
  readonly customerId?: UserId;
  readonly panelId?: PanelId;
  readonly state?: ServiceState;
  readonly deliveryState?: ServiceDeliveryState;
}

/**
 * What a successful provision established, written in one statement.
 *
 * One statement because `services_provisioned_at_check` binds the state to the
 * timestamp — `(state = 'PENDING_PROVISION' OR state = 'UNRECONCILED') =
 * (provisioned_at IS NULL)` — so a transition that moved the state without the stamp
 * could not commit. That constraint is the reason this is a struct rather than four
 * setters.
 */
export interface ProvisionOutcome {
  readonly providerUserId: string | null;
  readonly subscriptionUrl: string | null;
  readonly expiresAt: Date | null;
  readonly trafficUsedBytes: bigint | null;
  readonly usageSyncedAt: Date | null;
}

export interface ServiceRepository {
  /**
   * Writes the service a settled order produced.
   *
   * Called inside the settling transaction, and it may LOSE — `services_tenant_order_key`
   * is unique on `(tenant_id, order_id)`, so a replayed settlement or a second replica
   * collides here rather than creating a second provider account. The loser gets
   * `null`, not an exception, because losing is a normal outcome of a correct system
   * and the caller's response is to read the winner's row.
   */
  create(
    scope: TenantContext,
    draft: ServiceDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<ServiceRecord | null>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<ServiceRecord | null>;

  findByOrderId(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<ServiceRecord | null>;

  list(
    scope: TenantContext,
    search: ServiceSearch,
    limit: number,
    cursor: ServiceCursor | null,
    tx?: unknown,
  ): Promise<ServicePage>;

  /**
   * Moves a service between two states, and reports whether the row actually moved.
   *
   * A conditional `UPDATE … WHERE state = from`, for the reason ADR-0028 gives and
   * `OrderRepository.transition` repeats: it makes a replay, a double-click and two
   * replicas produce one transition without a lock. There is no `setState`.
   */
  transition(
    scope: TenantContext,
    id: string,
    from: ServiceState,
    to: ServiceState,
    outcome: ProvisionOutcome | null,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Records what a delivery attempt did, conditionally on the state it was tried from.
   *
   * Separate from `transition` because delivery is a separate axis: a delivery that
   * failed must not be able to move a service out of `ACTIVE`, and giving the two
   * axes one setter is how it eventually would.
   */
  recordDelivery(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    to: ServiceDeliveryState,
    stamps: { readonly deliveredAt: Date | null; readonly nextAttemptAt: Date | null },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Takes the services whose announcement is due, for THIS sweep. Bounded, oldest first.
   *
   * A claim, not a read. It pushes `delivery_next_attempt_at` out to `leaseUntil` in the
   * same statement that selects, so a second replica sweeping concurrently does not find
   * the same rows and send the customer a second "your service is ready". Two replicas
   * are the normal case on every rolling update, and a duplicate announcement is a
   * customer wondering which of the two links is the real one.
   *
   * The lease is NOT an attempt, and nothing here touches `delivery_attempts`. An attempt
   * is an outcome we know — `recordDelivery` counts it — and a sweep that died holding a
   * lease learned nothing. Counting the lease instead would let a process that crashes
   * between claim and send exhaust a service's three attempts without a single message
   * ever being submitted to Telegram.
   */
  claimDeliveryDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]>;
}

/**
 * Where one customer's announcement goes.
 *
 * `botInstanceId` rather than "the tenant's active bot", because `CustomerMessage`
 * forbids exactly that: a customer wrote to a specific bot, and a message from a
 * different one arrives from an account they have never heard of — which, for a tenant
 * running a public bot beside a reseller bot, leaks the relationship between them.
 */
export interface CustomerContact {
  readonly chatId: string;
  readonly botInstanceId: BotInstanceId;
}

/**
 * Where to send one customer's service announcement, or nothing.
 *
 * A NARROW port, for the reason `PurchaseSnapshotReader` gives one line above: handing
 * the delivery sweep `CustomerRepository` would also hand a background worker
 * `setStatus`, and therefore the ability to block or unblock a customer.
 *
 * `null` means REFUSE, never "fall back to some bot". The only durable customer-to-bot
 * link is `customers.first_bot_instance_id`, which is nullable; a customer whose row has
 * none cannot be announced to automatically, and guessing is the failure mode above.
 */
export interface CustomerContactReader {
  contactFor(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerContact | null>;
}

/**
 * One attempt at one external effect.
 *
 * `operationId` is DERIVED from the idempotency key and unique per tenant. Two workers
 * retrying one command derive the same value with no lookup, so the second insert loses
 * on `provisioning_operations_tenant_operation_key` rather than starting a second
 * provider call. That is the whole design, and it is why `id` — a per-row UUID — is
 * NOT the identity here.
 */
export interface OperationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly operationId: OperationId;
  readonly serviceId: string;
  readonly orderId: OrderId | null;
  readonly panelId: PanelId;
  readonly type: OperationType;
  readonly state: OperationState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly claimedBy: string | null;
  readonly leaseUntil: Date | null;
  readonly callStartedAt: Date | null;
  readonly providerReference: string | null;
  readonly failureKind: ProviderFailureKind | null;
  readonly failureMessage: string | null;
  readonly completedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OperationDraft {
  readonly id: string;
  readonly operationId: OperationId;
  readonly serviceId: string;
  readonly orderId: OrderId | null;
  readonly panelId: PanelId;
  readonly type: OperationType;
}

export interface OperationRepository {
  /**
   * Plans an operation, or reports that one with this derived id already exists.
   *
   * `ON CONFLICT DO NOTHING` on `(tenant_id, operation_id)` and a read-back. Returning
   * the EXISTING row rather than throwing is what makes a retried command idempotent
   * at the only place it can be: the caller cannot tell whether it or somebody else
   * planned it, and does not need to.
   */
  plan(
    scope: TenantContext,
    draft: OperationDraft,
    now: Date,
    tx: TransactionScope,
  ): Promise<OperationRecord>;

  findById(scope: TenantContext, id: string, tx?: unknown): Promise<OperationRecord | null>;

  findByOperationId(
    scope: TenantContext,
    operationId: OperationId,
    tx?: unknown,
  ): Promise<OperationRecord | null>;

  listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Takes one due operation for this worker, or reports there is none.
   *
   * A conditional `UPDATE … WHERE state = 'PLANNED' AND (next_attempt_at IS NULL OR
   * next_attempt_at <= now)` over a single row chosen by the due index, which is what
   * makes two replicas safe with no advisory lock and no coordination. The claim and
   * the attempt increment are the same statement: a claim that did not count its
   * attempt is a claim that can be retried for ever.
   */
  claimDue(
    scope: TenantContext,
    worker: string,
    now: Date,
    leaseUntil: Date,
    tx?: unknown,
  ): Promise<OperationRecord | null>;

  /**
   * Stamps `call_started_at` and COMMITS ON ITS OWN, before the provider is called.
   *
   * The one fact that distinguishes "a worker died before calling" from "a worker died
   * during a call", and therefore the one fact that decides whether a lease expiry may
   * safely release this row. It takes no transaction argument deliberately: committing
   * it inside the caller's transaction would mean a crash rolled it back, which is
   * precisely the case it exists to record.
   */
  markCallStarted(scope: TenantContext, id: string, at: Date): Promise<void>;

  /**
   * Moves an operation between two states, and reports whether the row moved.
   *
   * The same conditional-UPDATE discipline as everywhere else, with the terminal
   * stamp written by the same statement because
   * `provisioning_operations_completed_check` binds them.
   */
  transition(
    scope: TenantContext,
    id: string,
    from: OperationState,
    to: OperationState,
    result: {
      readonly providerReference?: string | null;
      readonly failureKind?: ProviderFailureKind | null;
      readonly failureMessage?: string | null;
      readonly nextAttemptAt?: Date | null;
      readonly completedAt?: Date | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Returns expired leases to `PLANNED`, but ONLY where no provider call was started.
   *
   * The `leaseExpiredAndCallNeverStarted` guard `OPERATION_MACHINE` names, as a
   * WHERE clause. A row whose `call_started_at` is set is deliberately left
   * `IN_FLIGHT`: handing it to another worker would repeat a mutation that may have
   * taken effect, and leaving it is what a human can then reconcile.
   */
  releaseExpiredLeases(scope: TenantContext, now: Date, limit: number): Promise<number>;

  /** Operations whose outcome is unknown, oldest first. The reconciliation queue. */
  listUnknown(
    scope: TenantContext,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]>;
}

/**
 * Why a panel cannot be operated, when it cannot.
 *
 * A closed set, because each member is a different screen for an operator to go to and
 * the `reason` detail on `PANEL_NOT_OPERABLE` carries exactly this. "It did not work"
 * is what the legacy system says; this is the alternative.
 */
export type PanelOperabilityRefusal =
  /** The operator switched it off. `DISABLED` means stop using this for now. */
  | 'PANEL_DISABLED'
  /** Archived, or gone. */
  | 'PANEL_ABSENT'
  /** No adapter for its provider type, or none implementing the service half. */
  | 'PROVIDER_NOT_OPERABLE'
  /** The adapter does not declare the capability this operation needs. */
  | 'CAPABILITY_UNSUPPORTED'
  /** Credentials are not set, or not the shape this provider can use. */
  | 'CREDENTIALS_MISSING'
  /** A field the provider requires before it can build a config is unset. */
  | 'ACTIVATION_INCOMPLETE';

/**
 * A panel resolved into everything one operation needs, or why it could not be.
 *
 * Resolved in ONE place so that "can this panel do this" has one answer. The
 * alternative — each caller checking status, then adapter, then capability, then
 * credentials — is four checks in four orders, and the one that gets skipped is
 * always the last.
 */
export type PanelOperability =
  | {
      readonly ok: true;
      readonly providerType: string;
      readonly baseUrl: string;
      readonly activation: PanelActivation;
    }
  | { readonly ok: false; readonly reason: PanelOperabilityRefusal };

/**
 * What a provisioning run reported, for the operational log and for a surface.
 *
 * Never a raw provider response. `failureMessage` is bounded and redacted by the
 * executor before it reaches here; `docs/open-questions.md` records customer- and
 * provider-supplied text reaching an operational projection as the Phase 4 hazard.
 */
export interface ProvisionAttemptReport {
  readonly operationId: OperationId;
  readonly serviceId: string;
  readonly outcome: OperationState;
  readonly failureKind: ProviderFailureKind | null;
}

/**
 * What was bought, for the order that created a service.
 *
 * A NARROW port, deliberately, for the reason the catalogue's `PanelOwnershipReader`
 * gives: the provisioning module has no business reading an order's totals, its
 * customer or its state, and handing it `OrderRepository` would also hand it
 * `transition` — the ability to settle an order from a background worker.
 *
 * It needs exactly two numbers, and it must read them from the ORDER's snapshot rather
 * than from the product: `nexa_orders_snapshot_guard` froze that snapshot at
 * confirmation, so it is the only copy that still says what the customer agreed to. A
 * product re-specified since would otherwise silently change the size of a service
 * somebody already paid for.
 */
/**
 * Whether one panel can be operated, without decrypting anything.
 *
 * A NARROW port over what `decideOperability` needs: the panel's own four fields and a
 * credential SUMMARY of three timestamps. A surface answering "can this be retried"
 * must not materialise a password to find out, and a signature that cannot receive one
 * is a stronger guarantee than a rule about not passing one.
 */
export interface PanelOperabilityReader {
  operability(
    scope: TenantContext,
    panelId: PanelId,
    type: OperationType,
    tx?: unknown,
  ): Promise<PanelOperability>;
}

export interface PurchaseSnapshotReader {
  specificationFor(
    scope: TenantContext,
    orderId: OrderId,
    tx?: unknown,
  ): Promise<ProductSpecification | null>;
}
