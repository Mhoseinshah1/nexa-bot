import type {
  BotInstanceId,
  OperationId,
  OperationState,
  OperationTarget,
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
  /** The panel's `subId` for this service. A bearer capability; never derived. */
  readonly subscriptionRef: string;
  /** The client UUID the customer's configuration authenticates with. A credential. */
  readonly providerClientId: string;
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
  /** Set while a send has been handed to Telegram and no outcome has been recorded. */
  readonly deliverySendStartedAt: Date | null;
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
  /**
   * Both chosen by the caller, in the settling transaction, BEFORE any provider call.
   *
   * Written that early for the reason the derivation used to give: a create whose
   * answer was lost must still be reconcilable, and a value committed before the call
   * survives losing the answer just as well as a value that can be recomputed — without
   * being recomputable by anybody who learns the service id.
   */
  readonly subscriptionRef: string;
  readonly providerClientId: string;
  readonly trafficLimitBytes: bigint;
}

/**
 * Unguessable values for the two service identities that are capabilities.
 *
 * A NARROW port, and separate from `IdGenerator` on purpose. `IdGenerator.uuid()` is
 * UUIDv7 — time-ordered and partly predictable, which is exactly right for a primary key
 * and exactly wrong for a credential. A single port offering both is a port whose next
 * caller picks the wrong one.
 */
export interface ServiceSecretSource {
  /** Lowercase hex, `bytes` long. The panels' `subId` format is 16 bytes of it. */
  hex(bytes: number): string;
  /** A random v4 UUID, which is what a panel that keys clients by one validates. */
  clientId(): string;
}

export interface ServiceCursor {
  /**
   * The stored `created_at`, as PostgreSQL's OWN text, NEVER as a `Date`.
   *
   * This was a `Date` until 4H exposed the list over HTTP, and it was the defect
   * `CustomerCursor` and `PanelCursor` already carry the measurement for:
   * `timestamptz` keeps microseconds, a JavaScript `Date` keeps milliseconds, and the
   * driver TRUNCATES rather than rounds. A cursor built from a `Date` is therefore
   * strictly BELOW the row it was built from whenever that row's microseconds are
   * non-zero, so the tuple comparison lets that row back in — one duplicate at every
   * page boundary, and at `limit=1` a traversal that never ends because each page
   * hands back the same cursor.
   *
   * It was latent rather than harmless: nothing paged services from outside this
   * process, so the only caller was a test that read one page. `services.created_at` is
   * written from a millisecond `Clock.now()` today, so the rows with microseconds are
   * the ones a restore, an import or an ops script created — exactly the set nobody
   * would think to test.
   */
  readonly createdAt: string;
  readonly id: string;
}

export interface ServicePage {
  readonly items: readonly ServiceRecord[];
  readonly nextCursor: ServiceCursor | null;
}

export interface ServiceSearch {
  readonly customerId?: UserId;
  /**
   * The order that bought this service. EXACT, and at most one row can match.
   *
   * `services_tenant_order_key` is unique on `(tenant_id, order_id)`, so this is
   * a lookup rather than a filter — it exists because the Web Admin order page
   * had no way to reach the service its order produced, and an operator reading
   * a REFUNDED order could see the money and nothing about why.
   */
  readonly orderId?: string;
  readonly panelId?: PanelId;
  readonly state?: ServiceState;
  readonly deliveryState?: ServiceDeliveryState;
  /**
   * The account name on the panel, matched EXACTLY and never as a prefix.
   *
   * Exact because a prefix search over account names is an enumeration of a
   * panel's accounts: `nx` returns every service this installation ever sold,
   * and a `subscriptionUrl` is a bearer capability. The caller that wants
   * browsing has a cursor; this one answers "which service is THIS name".
   *
   * The value arrives already canonicalised by `providerUsernameLookupSchema`
   * — trimmed, ASCII-folded to lowercase, and validated against the grammar
   * this product actually stores — so the repository compares it as written
   * and the index above can serve it. A repository that folded case itself
   * would be a second opinion about what a username is.
   */
  readonly providerUsername?: string;
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

  /**
   * Reads one service and holds its row lock until the transaction ends (WP6-C).
   *
   * `SELECT … FOR UPDATE`. The ONE place a service row is locked on purpose, and the
   * reason is a rule that is a READ followed by a write: a customer's rotation cooldown
   * counts the rotations already recorded and then plans another, and without a lock
   * two taps under different keys both count none and both plan. The second waits here
   * instead, and then sees the first. `docs/wp6c-audit.md` C2.
   */
  lockForUpdate(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<ServiceRecord | null>;

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
   *
   * `sentUrl` is the link the attempt was about, and the row must STILL hold it. A
   * rotation can replace the link while a send of the old one is in flight; without
   * this, that send's completion would record `DELIVERED` against the new link and the
   * new link would never be sent — a customer holding a dead link beside a service that
   * says it was delivered. Required rather than optional so no caller can forget it;
   * `null` only where no link was involved at all.
   */
  recordDelivery(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    to: ServiceDeliveryState,
    stamps: {
      readonly deliveredAt: Date | null;
      readonly nextAttemptAt: Date | null;
      readonly sentUrl: string | null;
    },
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
  /**
   * Records that a send is about to leave, before it leaves. Answers whether it did.
   *
   * `markCallStarted` for the announcement half, with the same obligation on the
   * caller: its own transaction, committed before the send, so a crash cannot roll back
   * the one fact that says a message may already be out. A `false` means somebody else
   * moved the row first and this caller must send nothing.
   *
   * `sentUrl` is the link about to be sent, and the row must still hold it — the same
   * compare-and-set `recordDelivery` makes, for the window before the send rather than
   * after it.
   */
  markSendStarted(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    sentUrl: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Records that Telegram rate-limited the announcement: still due, no attempt spent.
   *
   * Its own method rather than a flag on `recordDelivery`, because that one ALWAYS
   * advances `delivery_attempts` and here it must not. ADR 0030 §2 carries the
   * argument: the ceiling bounds definite refusals OF THIS MESSAGE, and a 429 is
   * Telegram declining to look at it, not an outcome about it.
   *
   * `delivery_send_started_at` is cleared, because a 429 means the request was DECLINED
   * rather than lost — so the row is safely claimable again at `retryAt` instead of
   * waiting for `reapStrandedSends` to call it unknown.
   */
  recordRateLimited(
    scope: TenantContext,
    id: string,
    from: ServiceDeliveryState,
    retryAt: Date,
    /** The link that was declined. The row must still hold it — see `recordDelivery`. */
    sentUrl: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Stores a subscription link a rotation produced, and re-arms delivery so the customer
   * is sent it.
   *
   * Conditional on the service still being in one of `legalFrom`: a service ended while
   * the rotation was in flight keeps its terminal state and is not re-armed. Delivery is
   * reset whole — `PENDING`, no attempts, no backoff, no send in progress, not delivered
   * — because the link being delivered is a different one, and every one of those
   * columns described the old link. Clearing `delivery_send_started_at` is what lets an
   * overtaken send of the old link fail its own compare-and-set (`recordDelivery`)
   * without stranding the row for `reapStrandedSends`.
   */
  recordRotation(
    scope: TenantContext,
    id: string,
    subscriptionUrl: string,
    legalFrom: readonly ServiceState[],
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Resolves sends whose sender died, so the automatic lane never repeats one.
   *
   * A stamped row past its lease becomes `UNCONFIRMED` if it was `PENDING`, and simply
   * loses the stamp otherwise. No attempt is spent: an attempt means an outcome somebody
   * observed, and the point of this row is that nobody did.
   */
  reapStrandedSends(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number>;

  claimDeliveryDue(
    scope: TenantContext,
    now: Date,
    leaseUntil: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]>;

  /**
   * The services whose usage figure has gone stale. Bounded, stalest first.
   *
   * A READ, not a claim — unlike `claimDeliveryDue`, which leases what it selects. The
   * exclusivity a second replica needs is already provided one layer up: `plan` is
   * `ON CONFLICT DO NOTHING` on the DERIVED operation id, so two replicas listing the
   * same services in the same window produce one operation row between them. Leasing
   * here as well would be a second mechanism for the same guarantee, and the failure
   * mode of a lease nobody releases is a service that is never synced again.
   *
   * `ACTIVE` only, and only where a provider account exists. A service still being
   * provisioned has nothing to read, and a suspended or expired one is not consuming —
   * spending a tenant's outbound budget to re-read a figure that cannot have moved is
   * exactly the kind of unattended traffic the budget bounds.
   *
   * Stalest first, with a figure that has NEVER been refreshed counting as the stalest
   * of all. That ordering is what makes the bound safe: the next tick resumes where
   * this one stopped rather than starting again at the top, so no service at the back
   * of a large tenant's queue waits for ever.
   */
  listUsageSyncDue(
    scope: TenantContext,
    staleBefore: Date,
    limit: number,
    tx?: unknown,
  ): Promise<readonly ServiceRecord[]>;

  /**
   * Writes what a panel said this service has used, and when it was asked.
   *
   * Conditional on the service still being `ACTIVE`, for the reason every other write
   * in this module is conditional: a service suspended, expired or terminated during
   * the provider call must keep what that transition wrote, and a `setUsage` would
   * quietly overwrite it with a figure read before the change. Reports whether the row
   * actually moved.
   *
   * Separate from `transition` because usage is a separate axis, the same way delivery
   * is: a usage read must not be able to move a service between states, and giving the
   * two one setter is how it eventually would.
   */
  recordUsage(
    scope: TenantContext,
    id: string,
    usage: { readonly usedBytes: bigint; readonly syncedAt: Date },
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Writes what a commercial operation bought, conditionally on the state it was
   * planned from.
   *
   * A THIRD axis beside `transition` and `recordDelivery`, and separate for the reason
   * they are separate from one another: a renewal must not be able to move a service
   * the way a provider outcome can, and one setter that could write a state and an
   * allowance together is how it eventually would.
   *
   * `from` and `to` may be the SAME state, and usually are — renewing an `ACTIVE`
   * service buys it more time and leaves it active. `SERVICE_MACHINE` has no
   * `ACTIVE -> ACTIVE` edge and must not grow one; that is why this is not `transition`
   * with a null outcome. The one case where they differ is the machine's own
   * `EXPIRED -> ACTIVE on RENEW`, which is the edge Phase 4F finally gives a caller.
   *
   * A `null` field is one the operation did not buy, and it is left exactly as it is —
   * the same meaning it has on the operation row and in the provider call, so the three
   * agree without anybody translating between them.
   *
   * Returns false when the service moved under the call, which is a normal outcome: a
   * service terminated while the panel was being asked keeps what that termination
   * wrote. The OPERATION still succeeded, because the panel really did apply the
   * change, and saying otherwise would be a lie about an external effect.
   */
  recordAllowance(
    scope: TenantContext,
    id: string,
    from: ServiceState,
    to: ServiceState,
    allowance: {
      readonly expiresAt: Date | null;
      readonly trafficLimitBytes: bigint | null;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Moves services whose window has closed to `EXPIRED`, and returns them AS THEY WERE.
   *
   * One conditional UPDATE with `RETURNING`, rather than a select followed by writes.
   * Between a read and a separate write a service can be suspended, terminated or
   * renewed, and the write would then move a row the read had no right to — the same
   * race `transition` avoids by naming its `from`. Here the `from` is a SET, because
   * `SERVICE_MACHINE` has `EXPIRE` from both `ACTIVE` and `SUSPENDED`.
   *
   * The returned records carry the state each row was in BEFORE the move, which is
   * what an audit record's `before` needs and what a `RETURNING *` after an UPDATE
   * cannot give — so the caller is handed the old state explicitly rather than being
   * left to assume every expired service was ACTIVE.
   *
   * `expires_at IS NULL` is an unlimited plan and is never due. `provisionCall` writes
   * the panel's own unlimited rather than an epoch, so there is no zero to mistake for
   * a date in 1970.
   */
  expireDue(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
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
 * `NONE` means REFUSE, never "fall back to some bot". The only durable customer-to-bot
 * link is `customers.first_bot_instance_id`, which is nullable; a customer whose row has
 * none cannot be announced to automatically, and guessing is the failure mode above.
 *
 * ## Why `BLOCKED` is its own answer and not simply another refusal
 *
 * The delivery claim excludes blocked customers in its own query, so under no
 * concurrency this case never arises. It arises in the window between the claim and this
 * read: an operator blocking a customer right then would otherwise have the sweep
 * announce to them anyway, because a freshly read row's status was never consulted.
 *
 * Folding it into `NONE` would fix the send and break the record. `NONE` is recorded as
 * `FAILED` — a customer with no bot link never gains one by waiting — whereas a block is
 * temporary by design, and the query already treats it that way: an unblocked customer's
 * service is due again. Marking it `FAILED` on the race would take the automatic
 * announcement away from a customer whose block was lifted an hour later, which is the
 * opposite of what blocking one means.
 */
export type CustomerContactLookup =
  | { readonly kind: 'CONTACT'; readonly contact: CustomerContact }
  /** The customer exists and an operator has blocked them. Not now; possibly later. */
  | { readonly kind: 'BLOCKED' }
  /** No customer, or no durable bot link. Nothing to wait for. */
  | { readonly kind: 'NONE' };

export interface CustomerContactReader {
  contactFor(
    scope: TenantContext,
    customerId: UserId,
    tx?: unknown,
  ): Promise<CustomerContactLookup>;
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
  /** The customer who asked for this, or null when nobody did. See `OperationDraft`. */
  readonly requestedByCustomerId: UserId | null;
  readonly panelId: PanelId;
  readonly type: OperationType;
  readonly state: OperationState;
  readonly attempts: number;
  readonly nextAttemptAt: Date | null;
  readonly claimedBy: string | null;
  readonly leaseUntil: Date | null;
  readonly callStartedAt: Date | null;
  /**
   * What a commercial operation is trying to make true, absolute, or null on every
   * other type.
   *
   * `provisioning_operations_target_check` refuses one on anything but `RENEW`,
   * `ADD_TRAFFIC` and `ADD_TIME`, and `..._target_present_check` refuses a commercial
   * operation that carries neither field — an operation that asks the panel for nothing
   * while an order records that a customer paid for something.
   */
  readonly target: OperationTarget | null;
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
  /**
   * The customer who ASKED for this operation, or null when nobody did.
   *
   * Required rather than optional, unlike `target` below, because the honest value is
   * not the same at every call site and a default would pick one of them silently.
   * Phase 6A gave operators their own path to `SUSPEND`, `RESUME` and `TERMINATE`, and
   * from the row's TYPE those are indistinguishable from the customer's own — so the
   * announcer decided from the type and told a customer that the request THEY made had
   * been applied, for a change an operator ordered. Null here is what keeps it quiet.
   *
   * It is not an actor and does not authorize anything. Who was authorised to ask is
   * in the audit row; this says only whether somebody is owed the answer.
   */
  readonly requestedByCustomerId: UserId | null;
  readonly panelId: PanelId;
  readonly type: OperationType;
  /**
   * Computed ONCE, by the caller, inside the transaction that settles the order.
   *
   * Optional, because seven of the ten operation types have no target and passing
   * `null` at each of those call sites would be noise. Absent means null, and the CHECK
   * constraints make the two directions of that mistake impossible to persist.
   *
   * It must not be recomputed later. A target derived at execution time from whatever
   * the panel currently holds would differ between an attempt and its replay, and the
   * arithmetic would compound into a customer receiving two renewals for one payment —
   * which is the property `IDEMPOTENT_MUTATIONS` now depends on for these three types.
   */
  readonly target?: OperationTarget | null;
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

  /**
   * The one operation of this type that is still open for a service, if any.
   *
   * "Open" is `PLANNED` or `IN_FLIGHT` — the two states
   * `provisioning_operations_open_provision_key` admits at most one of. Reading it is
   * what lets a second retry RETURN the attempt already under way instead of planning
   * a rival one, which is the difference between an idempotent button and a service
   * stranded in `UNRECONCILED` by a double-click.
   */
  findOpen(
    scope: TenantContext,
    serviceId: string,
    type: OperationType,
    tx?: unknown,
  ): Promise<OperationRecord | null>;

  /**
   * Any open `RENEW`, `ADD_TRAFFIC` or `ADD_TIME` for this service.
   *
   * Its own method rather than three `findOpen` calls, because the question is not
   * "is this kind in flight" but "has anything already been computed from the two
   * columns I am about to read". A commercial target is ABSOLUTE and is derived once
   * from the service row, so a second purchase settling against the same reading plans
   * the same number: two five-gigabyte packages against a ten-gigabyte service each
   * plan fifteen, both are charged, and the panel ends where one would have left it.
   *
   * The DURABLE guarantee is `provisioning_operations_open_commercial_key`, not this
   * read — two replicas settling two orders in the same instant both see nothing here.
   * This exists so the refusal has a NAME and a customer is told "not yet" rather than
   * meeting a unique-violation reported as a 500.
   */
  findOpenCommercial(
    scope: TenantContext,
    serviceId: string,
    tx?: unknown,
  ): Promise<OperationRecord | null>;

  /**
   * A service's operations, OLDEST first, bounded.
   *
   * The order is part of the contract because a caller counts with it:
   * `ProvisionerService` reads the first 50 to count provisioning cycles against a
   * ceiling, and a limit applied to the other end of the same list would count a
   * different set. Anything that wants the RECENT history wants
   * `listRecentForService`.
   */
  listForService(
    scope: TenantContext,
    serviceId: string,
    limit: number,
    tx?: unknown,
  ): Promise<readonly OperationRecord[]>;

  /**
   * When the newest operation of this type that a CUSTOMER asked for, and that
   * SUCCEEDED, was requested — or null if there is none (WP6-C).
   *
   * The customer rotation cooldown's one input (`docs/wp6c-audit.md` C2). Three
   * predicates, each of which is the rule:
   *
   * - `requested_by_customer_id` is this customer. An operator's rotation is the
   *   operator's decision and does not spend the customer's allowance, and a previous
   *   owner's cannot exist, because a service never changes customer.
   * - `state = 'SUCCEEDED'`. A failed or abandoned rotation changed nothing the customer
   *   holds — a rotation is settled by a read-back — so charging it would refuse
   *   somebody whose link never changed.
   * - newest `created_at`, the request instant, which the service index leads with.
   */
  lastSucceededCustomerRequest(
    scope: TenantContext,
    serviceId: string,
    customerId: string,
    type: OperationType,
    tx?: unknown,
  ): Promise<Date | null>;

  /**
   * A service's operations, NEWEST first, bounded.
   *
   * Its own method rather than a flag on `listForService`, because the two answer
   * different questions and one of them bounds a decision. The operator's history is
   * the newest N attempts — "why has this customer not had their service" is answered
   * by the last failure, never by the first fifty — and the Codex review of PR #30
   * found the admin endpoint serving the OLDEST fifty behind a docblock promising the
   * newest, which is precisely the case where the history is long enough to matter.
   */
  listRecentForService(
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
    tx: TransactionScope,
  ): Promise<OperationRecord | null>;

  /**
   * Stamps `call_started_at` in a transaction OF ITS OWN, before the provider is called.
   *
   * The one fact that distinguishes "a worker died before calling" from "a worker died
   * during a call", and therefore the one fact that decides whether a lease expiry may
   * safely release this row.
   *
   * Its own transaction is the requirement, and it is the caller's job to give it one:
   * committing this inside a transaction that also holds the RESULT would mean a crash
   * rolled it back, which is precisely the case it exists to record. It takes a
   * `TransactionScope` rather than opening none at all so that the write passes
   * `DrizzleUnitOfWork.run` — ADR-0028's quiesce gate lives there, and a restore must
   * not find the provisioner still writing to the database it is replacing.
   *
   * Takes the WORKER and answers whether it stamped. The lease can expire in the window
   * between the claim and this call, and a released-then-reclaimed operation stamped by
   * the worker that stalled is two workers calling one panel for one paid order. So the
   * implementation asserts the whole claim, and a caller that is told `false` must make
   * no provider call.
   */
  markCallStarted(
    scope: TenantContext,
    id: string,
    worker: string,
    at: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

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
   * Puts a claimed operation back and REFUNDS the attempt the claim counted.
   *
   * Separate from `transition` because of the refund, and the refund is the whole
   * point. The attempt counter bounds PROVIDER CALLS — that is why `claimDue` counts
   * one in the same statement as the claim — and a hold-off contacted nothing: the
   * tenant was stopped, or the tenant's outbound budget had no capacity. Spending an
   * attempt on it means an operator stopping a tenant for twenty-five seconds, at the
   * default tick, retires a paid order that no panel ever heard about.
   *
   * Conditional on `IN_FLIGHT` like every other transition, so a hold-off cannot
   * refund an attempt for a row somebody else has already moved.
   */
  holdOff(
    scope: TenantContext,
    id: string,
    retryAt: Date,
    note: string,
    now: Date,
    tx: TransactionScope,
  ): Promise<boolean>;

  /**
   * Fails `PLANNED` operations whose attempts are spent, and reports which.
   *
   * The counterpart to `claimDue`'s `attempts < OPERATION_MAX_ATTEMPTS` predicate.
   * That predicate makes an exhausted row unclaimable, and every path that SPENDS the
   * last attempt moves the row to a terminal state itself — except a crash. A worker
   * that died holding the last attempt leaves the row `IN_FLIGHT`; the lease sweep
   * returns it to `PLANNED`; and there it sits, at the ceiling, unclaimable and
   * uncompleted, with no operational event and nothing that would ever look at it
   * again. A paid order, invisible.
   *
   * Returns the rows so the caller can open the stalled condition for each: an
   * operator needs to see this, and the recorder is the application's to call.
   */
  retireExhausted(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Returns expired leases to `PLANNED`, but ONLY where no provider call was started.
   *
   * The `leaseExpiredAndCallNeverStarted` guard `OPERATION_MACHINE` names, as a
   * WHERE clause. A row whose `call_started_at` is set is deliberately left
   * `IN_FLIGHT`: handing it to another worker would repeat a mutation that may have
   * taken effect, and leaving it is what a human can then reconcile.
   */
  releaseExpiredLeases(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<number>;

  /**
   * Takes operations a crash stranded mid-call off `IN_FLIGHT`, for good.
   *
   * The complement of `releaseExpiredLeases`, which refuses exactly these rows. A
   * mutating one becomes `UNKNOWN` — the state whose only exit is a read, which is the
   * queue `listUnknown` serves — and a non-mutating one becomes `FAILED`, because a read
   * that never answered changed nothing. Without it a process that died between the
   * stamp and the answer left a paid order waiting for ever.
   */
  reapStrandedCalls(
    scope: TenantContext,
    now: Date,
    limit: number,
    tx: TransactionScope,
  ): Promise<readonly OperationRecord[]>;

  /**
   * Closes a service's outstanding `UNKNOWN` operations once a read has answered.
   *
   * The `RECONCILE_SUCCEEDED` and `RECONCILE_FAILED` edges `OPERATION_MACHINE` declares,
   * finally used. `UNKNOWN` is otherwise a state nothing leaves, and an unresolved one
   * outlives its own reconcile to jam the queue in front of the next service waiting.
   */
  resolveUnknownForService(
    scope: TenantContext,
    serviceId: string,
    to: Extract<OperationState, 'SUCCEEDED' | 'FAILED'>,
    now: Date,
    tx: TransactionScope,
  ): Promise<number>;

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
