import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_SYNC_MIN_INTERVAL_MS,
  customerActionVerdict,
  effectiveCooldownMs,
  type PanelCustomerAction,
  SERVICE_NOTE_MAX_LENGTH,
  SERVICES_LIST_PAGE_SIZE,
  extendedAllowance,
  extendedExpiry,
  errors,
  MAX_DEVICE_LIMIT,
  MAX_TRAFFIC_BYTES,
  extendedDeviceLimit,
  NexaError,
  SUBSCRIPTION_REF_BYTES,
  DEFAULT_USERNAME_PREFIX,
  drawUsernameCharacters,
  SERVICE_PAGE_MAX,
  UNLIMITED_TRAFFIC_BYTES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationId,
  type OperationTarget,
  type OrderId,
  type OperationType,
  type PermissionKey,
  type ServiceState,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import { OPERATION_LEGAL_FROM } from './provision-executor.js';
import { serviceIdOrNotFound } from './service-id.js';
import type { PanelSalesGate } from '../../../platform/panels/application/panel-sales-gate.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type {
  OperationRecord,
  ServiceCursor,
  ServicePage,
  ServiceRecord,
  ServiceSecretSource,
  ServiceRepository,
  OperationRepository,
  PanelOperabilityReader,
} from './ports.js';
import type { ServiceUsernameRepository } from './username-ports.js';
import type { CardMessageRef, OperationCardRepository } from './operation-card.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { FeatureFlagResolver } from '../../../control/features/application/feature-flags.service.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import {
  assertCustomerPolicyAllows,
  type PanelPolicyGate,
} from '../../../platform/panels/application/panel-policy.js';

/** Asking for a provider call to be made again is `services.edit`, not `services.view`. */
const SERVICE_EDIT_PERMISSION = 'services.edit';

/**
 * The default page size, shared with `ServiceAdminService` rather than copied.
 *
 * The MAXIMUM is not declared here at all: `SERVICE_PAGE_MAX` is the contract's, it is
 * what `serviceListQuerySchema` validates against, and a second copy of that number in
 * an application service is a bound that can disagree with the one the HTTP layer
 * enforces.
 */
export const SERVICE_PAGE_DEFAULT = 25;

export interface ProvisioningServiceDeps {
  readonly services: ServiceRepository;
  readonly operations: OperationRepository;
  readonly panels: PanelOperabilityReader;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Derives an operation id from a retry-stable key. Bound in the container. */
  readonly operationId: (idempotencyKey: string) => OperationId;
  /** The tenant kill switch, read inside every write transaction. */
  readonly scopeActivity: ScopeActivityReader;
  /** Unguessable values for the two identities that are capabilities, not ids. */
  readonly secrets: ServiceSecretSource;
  /**
   * The name this order reserved before it was paid for.
   *
   * Read here rather than decided here: the allocator chose it at confirmation, the
   * customer saw it in the summary they agreed to, and the unique index has been
   * holding it since. Deciding again at settlement would be a second opinion about
   * the one string that has to match what is on the panel.
   */
  readonly usernames: ServiceUsernameRepository;
  /**
   * The holder of the panel slot this order took at confirmation.
   *
   * Settlement is where that hold becomes a service, and the handover happens in
   * this transaction or not at all — see `planForSettledOrder`.
   */
  readonly panelSales: PanelSalesGate;
  /**
   * The three reads a customer's own rotation needs and no other request does (WP6-C):
   * its flag, its cooldown, and whether the customer is still allowed to act. Each is
   * read INSIDE the planning transaction, because a surface reads on arrival and a
   * change can commit in between.
   */
  readonly features: Pick<FeatureFlagResolver, 'isEnabled'>;
  readonly settings: Pick<SettingsResolver, 'valueOf'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  /**
   * The panel's operator policy (WP-A8): which of these a customer may ask for on this
   * panel, and the extra wait it adds. Read INSIDE the planning transaction by
   * `planWithin`, the one place every customer-originated operation passes, and asked
   * only after `panels.operability` — so it can refuse and never grant. Operator and
   * system operations never consult it.
   */
  readonly panelPolicy: PanelPolicyGate;
  /**
   * R3 item 10: where a customer's disable or enable was asked from, recorded beside the
   * operation in its planning transaction so the provisioner can show the result on that
   * card. Optional: without it the request is planned exactly as before.
   */
  readonly cards?: Pick<OperationCardRepository, 'attach'>;
  /**
   * A paid location change's frozen target (WP-A6), read by the order it was quoted on.
   * The key the operation will ask the panel for is the one the customer was shown — the
   * change request's snapshot — never today's configuration.
   */
  readonly locationChanges: {
    findByOrderId(
      scope: TenantContext,
      orderId: OrderId,
      tx?: unknown,
    ): Promise<{ readonly toLocationKey: string } | null>;
  };
}

/**
 * The panel-policy row each customer-originated operation is decided by (WP-A8).
 *
 * `SUSPEND` and `RESUME` are one row — "disable / enable" — because they are one
 * capability pair and one decision an operator makes about a panel.
 */
const CUSTOMER_OPERATION_POLICY_ROW: Readonly<Partial<Record<OperationType, PanelCustomerAction>>> =
  {
    SUSPEND: 'DISABLE_ENABLE',
    RESUME: 'DISABLE_ENABLE',
    ROTATE_SUBSCRIPTION: 'ROTATE_SUBSCRIPTION',
    SYNC_USAGE: 'USAGE_READ',
  };

/**
 * Round N (F4): the operations whose pending outcome changes what the service card may
 * say — its state (disable, enable), its link, or its location. While one is unsettled the
 * card reads «working» (`ProvisioningService.changeInProgress`).
 */
export const CARD_WORKING_OPERATIONS: readonly OperationType[] = [
  'SUSPEND',
  'RESUME',
  'ROTATE_SUBSCRIPTION',
  'CHANGE_LOCATION',
];

/**
 * What a customer's own rotation is charged against (WP6-C).
 *
 * The permission every other customer write through the webhook's `SYSTEM_JOB` takes —
 * trials and commercial actions — so the customer path is authorised through the guard
 * rather than by the absence of one (`docs/wp6-audit.md` A9).
 */
export const CUSTOMER_ROTATION_PERMISSION: PermissionKey = 'maintenance.run';

/**
 * The states a CUSTOMER may rotate from: `ACTIVE`, and only that.
 *
 * Narrower than the operator's `ACTIVE`/`SUSPENDED` (rotation audit D2) because the
 * delivery sweep sends only to an `ACTIVE` service. A suspended customer would be told
 * their request succeeded and receive no link. `docs/wp6c-audit.md` C1.
 */
export const CUSTOMER_ROTATION_STATES: readonly ServiceState[] = ['ACTIVE'];

/** What the surface needs to draw — or not draw — the rotation button. */
export type CustomerRotationOffer =
  { readonly offered: true; readonly cooldownHours: number } | { readonly offered: false };

/**
 * Services and the operations that produce them.
 *
 * ## Where a service comes from
 *
 * `planForSettledOrder` is called from inside `PaymentService.confirmAndSettle` — the
 * ONE place `SETTLE` is taken — in the same transaction. That placement is the
 * exactly-once rule: an order settles once, atomically, so if the service row is
 * written there then "one settled order produces at most one logical service" is a
 * consequence of the order machine plus a UNIQUE index, not of a worker behaving well.
 *
 * The alternative considered and rejected was consuming `PaymentConfirmed` from the
 * outbox and creating the service in a handler. That makes the guarantee depend on the
 * handler being idempotent, which is strictly weaker for no benefit.
 *
 * ## What does NOT happen here
 *
 * No provider is contacted. Not one byte leaves this process on this path. The
 * transaction writes two rows — a service in `PENDING_PROVISION` and an operation in
 * `PLANNED` — and commits; every provider call happens afterwards, in the executor,
 * outside any transaction. `docs/conventions.md` states the rule and
 * `scripts/check-boundaries.sh` enforces it, and the reason is that a transaction held
 * open across somebody else's network is a transaction whose duration somebody else
 * chooses.
 */
/**
 * The operations a CUSTOMER may ask for on their own service.
 *
 * Two. `TERMINATE` was the third and the owner removed it (WP15 G1): a customer ends a
 * service by asking an operator, never by a tap that deletes a provider account. Nothing
 * here decides whether it comes back as a refund request — that is deferred, and would be
 * a request an operator acts on, not an operation a customer plans.
 *
 * The list is here rather than in `@nexa/contracts` because it is a product
 * policy rather than a vocabulary: `OPERATION_TYPES` says what an operation can be, and
 * this says which of them a person who is not an operator is allowed to initiate.
 *
 * `PROVISION`, `RECONCILE` and `SYNC_USAGE` are absent because they are the system's
 * own work — a customer asking for a reconcile is asking to spend their tenant's
 * outbound budget on a question they cannot read the answer to. `RENEW`, `ADD_TRAFFIC`
 * and `ADD_TIME` are absent because they are purchases, and a purchase starts with an
 * order.
 *
 * A type not in this list cannot be reached through the customer surface at all: the
 * callback prefixes below are fixed strings and the type is chosen by which one
 * matched, never parsed out of what arrived.
 */
export const CUSTOMER_SERVICE_OPERATIONS = [
  'SUSPEND',
  'RESUME',
] as const satisfies readonly OperationType[];

export type CustomerServiceOperation = (typeof CUSTOMER_SERVICE_OPERATIONS)[number];

/**
 * The operations an OPERATOR may ask for on any service in their tenant.
 *
 * Phase 6A, and the difference from the customer list above is the whole reason both
 * exist. A customer initiates three, authorised by owning the service. An operator
 * initiates five, authorised by a permission — and gets the two the customer list calls
 * "the system's own work" because an operator can read the answer: `SYNC_USAGE` is the
 * refresh behind a usage figure they are about to act on, and `RECONCILE` is how an
 * `UNRECONCILED` service is resolved without waiting for the sweep's five-per-tick.
 *
 * `PROVISION` is absent and stays absent: `retryProvisioning` is its own method with its
 * own refusals, including the one that matters — an `UNRECONCILED` service must be
 * reconciled before anything asks a panel to create a second account for it.
 *
 * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` are absent for the reason the customer list
 * gives: they are purchases, and a purchase starts with an order. An operator granting
 * one for free is a Phase 7 product decision (`docs/open-questions.md`), not an
 * operation this list can quietly acquire.
 *
 * `ROTATE_SUBSCRIPTION` is the sixth, added with the first adapter that performs it. It
 * is operator-only on purpose: a customer-facing rotation needs a rate and abuse rule
 * nobody has decided (`docs/rickpanel-rotate-audit.md` D1).
 */
export const OPERATOR_SERVICE_OPERATIONS = [
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'SYNC_USAGE',
  'RECONCILE',
  'ROTATE_SUBSCRIPTION',
] as const satisfies readonly OperationType[];

export type OperatorServiceOperation = (typeof OPERATOR_SERVICE_OPERATIONS)[number];

/**
 * Which permission each operator operation charges.
 *
 * `TERMINATE` is `services.terminate` — a HIGH-risk key held by `owner` alone in the
 * frozen role catalogue — because it deletes the account on somebody's panel while the
 * customer keeps the order they paid for. The other five are `services.edit`: a rotation
 * replaces a link and keeps the account, the same weight as a suspend.
 *
 * A table rather than a conditional, so adding an operation cannot inherit the cheaper
 * key by being written in the wrong branch.
 */
export const OPERATOR_OPERATION_PERMISSION: Readonly<
  Record<OperatorServiceOperation, PermissionKey>
> = {
  SUSPEND: 'services.edit',
  RESUME: 'services.edit',
  TERMINATE: 'services.terminate',
  SYNC_USAGE: 'services.edit',
  RECONCILE: 'services.edit',
  ROTATE_SUBSCRIPTION: 'services.edit',
};

/**
 * The ONE refusal `operations.plan` raises that a refunding caller can absorb.
 *
 * Matched on `code`, not on the message: the message is customer-facing text and a
 * reword would silently turn this catch into a rethrow. `NexaError` is imported from
 * the frozen contracts, so `instanceof` is the same class the repository threw.
 *
 * Everything else — a collided primary key, a concurrent delete, a driver fault —
 * rethrows untouched. A catch that swallowed those would turn a broken database into
 * a refund, which is the failure this whole lane is supposed to be the opposite of.
 */
function isActionInProgress(error: unknown): boolean {
  return (
    error instanceof NexaError && error.code === COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS
  );
}

export class ProvisioningService {
  constructor(private readonly deps: ProvisioningServiceDeps) {}

  /**
   * Whether this order can be fulfilled on its panel — and the slot handover.
   *
   * Split out of `planForSettledOrder` because the ANSWER now decides which state the
   * order settles into, and that decision has to be made before the transition rather
   * than discovered after it. `SETTLE` and `SETTLE_UNFULFILLED` are different edges of
   * `ORDER_MACHINE` and there is deliberately no path from `PAID` back.
   *
   * `consume` takes the panel's lock, deletes the order's hold, and — on a first
   * settlement only — decides eligibility again with that hold no longer counted.
   * Releasing before counting is what stops the order's own reservation refusing the
   * order's own service on the last slot; the lock is held across the gap and the
   * service is written before this transaction commits, so nothing else can see it
   * free. When the hold has EXPIRED or was already released, the release is a no-op
   * and the count that follows is a fresh acquisition under the same lock: the order
   * competes for a slot exactly as a new one would, and wins or does not.
   *
   * ## `onIneligible`, and why the caller decides
   *
   * `REFUSE` throws, which rolls the whole transaction back. Right when the money is
   * still reversible IN this transaction — a wallet debit written moments ago — and
   * the only honest outcome, because an installation that cannot deliver must not keep
   * money it can still decline.
   *
   * `REFUND` returns the refusal, and the caller confirms the payment and gives the
   * money back. Right when the money has ALREADY MOVED: a bank transfer sitting in
   * the account cannot be un-received by throwing, and the refusal that used to
   * happen here left the payment `PENDING` — unconfirmable, and unrefundable,
   * because a refund needs a confirmed payment. Codex C4 on PR #50 found that; the
   * owner then removed the third outcome the fix had introduced, so the answer to
   * "we cannot deliver this" is now the money, not a queue.
   *
   * A REPLAY skips the decision entirely: the customer already has their service, and
   * re-judging would refuse a transaction whose money has already moved.
   */
  async prepareFulfilment(
    scope: TenantContext,
    order: OrderRecord,
    tx: TransactionScope,
    onIneligible: 'REFUSE' | 'REFUND',
  ): Promise<
    | { readonly outcome: 'FULFILLABLE' }
    | { readonly outcome: 'UNFULFILLABLE'; readonly reason: string }
  > {
    const alreadyProvisioned =
      (await this.deps.services.findByOrderId(scope, order.id, tx)) !== null;
    const eligible = await this.deps.panelSales.consume(
      scope,
      order.line.panelId,
      order.id,
      tx,
      alreadyProvisioned,
    );
    if (eligible.eligible) return { outcome: 'FULFILLABLE' };
    if (onIneligible === 'REFUND') {
      return { outcome: 'UNFULFILLABLE', reason: eligible.reason };
    }
    throw errors.preconditionFailed(
      COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE,
      'This order cannot be fulfilled on its panel.',
      { reason: eligible.reason },
    );
  }

  /**
   * Records that a settled order is owed a service, and plans the work.
   *
   * Idempotent by construction and not by checking. `create` is an upsert against
   * `services_tenant_order_key`, so a replayed settlement loses the insert and this
   * reads the winner's row; `plan` is an upsert against
   * `provisioning_operations_tenant_operation_key`, so the same replay finds the
   * operation already planned. Neither path branches on "have I done this before" —
   * a question a process cannot answer correctly when there are two of it.
   *
   * The operation id is derived from the SERVICE id rather than from the caller's
   * idempotency key, and that is deliberate. The service id is stable across replays
   * because the insert is idempotent; a per-request key is not, so two settlements of
   * one order would derive two operation ids and plan two creates.
   *
   * The slot was handed over by `prepareFulfilment`, which the caller runs FIRST and
   * under the panel's lock. This method writes; it does not decide.
   */
  async planForSettledOrder(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly service: ServiceRecord; readonly operation: OperationRecord }> {
    const serviceId = this.deps.ids.uuid();
    /*
     * The reserved name, and a default one ONLY when there is no reservation.
     *
     * Every order confirmed since the username policy shipped holds a reservation —
     * `OrderService.confirm` requires one. The fallback is for an order that was
     * already AWAITING_PAYMENT when this release was deployed: it was confirmed by
     * code that took no name, and refusing to settle it would strand money a customer
     * has already sent.
     *
     * It used to be `providerUsernameFor(serviceId)` — `nx` plus 32 hex, derived from
     * the service id. That shape is gone: the universal contract bounds every NEW name
     * at twenty characters, and a 34-character fallback would be this release minting
     * exactly what it refuses everywhere else. The fallback is now the default preset,
     * `nx` plus ten random characters, drawn from the same CSPRNG the allocator uses.
     *
     * Random rather than derived has one consequence worth stating: it cannot collide
     * deterministically, but it also cannot be recomputed. Neither matters here —
     * `providerRefFor` reads the stored column and reconciliation asks the panel about
     * the name the service row already carries — and the collision odds over 36^10 are
     * beneath the unique index that would catch them.
     *
     * Note the interaction with the losing `create` below: when another transaction
     * created this order's service first, `serviceId` is discarded and the winner's
     * row is used, along with the winner's name. The discarded row was never written.
     */
    const reserved = await this.deps.usernames.findByOrder(scope, order.id, tx);
    const providerUsername =
      reserved?.username ??
      `${DEFAULT_USERNAME_PREFIX}${drawUsernameCharacters(this.deps.secrets.hex(10), 10)}`;
    /*
     * Stamped in the SETTLING transaction, which is what makes it true.
     *
     * `funded_at` is the single field that stops the reaper taking this name back, and
     * the money for it commits here. A stamp written afterwards, in a later
     * transaction or by a job, leaves a window in which the customer has paid and the
     * name is still reapable.
     */
    if (reserved !== null) await this.deps.usernames.markFunded(scope, order.id, now, tx);
    const created = await this.deps.services.create(
      scope,
      {
        id: serviceId,
        customerId: order.customerId,
        orderId: order.id,
        panelId: order.line.panelId,
        productId: order.line.productId,
        providerUsername,
        /*
         * Random, and written here — before anything leaves the process.
         *
         * Committed in the settling transaction, so a create whose answer is lost can
         * still be reconciled against them; random, so learning the service id or
         * reading a name off a panel's client list yields neither. They used to be an
         * unkeyed hash of the service id, which made both a one-line computation from a
         * value the audit log, the operations log and the outbox all carry.
         */
        subscriptionRef: this.deps.secrets.hex(SUBSCRIPTION_REF_BYTES),
        providerClientId: this.deps.secrets.clientId(),
        /*
         * From the ORDER's snapshot, never from the product.
         *
         * `UNLIMITED_TRAFFIC_BYTES` is zero and the column stores zero for unlimited,
         * so no branch is needed — the sentinel and the storage agree, which is why
         * `catalog.ts` chose zero rather than null.
         */
        trafficLimitBytes: order.line.specification.trafficBytes,
        /*
         * WP-A5: the entitlement starts at what the order froze, and only an applied
         * `ADD_DEVICES` raises it. A value past the bound is not recorded rather than
         * clamped — a clamp would record a limit the panel was never given.
         */
        deviceLimit: recordableDeviceLimit(order.line.specification.deviceLimit),
      },
      now,
      tx,
    );

    /*
     * `create` returning null means this order already has a service.
     *
     * A NORMAL outcome — a replayed settlement, a second replica, a double-tapped
     * button — so the existing row is read and used. The service id that matters from
     * here on is the WINNER's, not the one minted above, because every derived
     * identity hangs off it.
     */
    const service = created ?? (await this.deps.services.findByOrderId(scope, order.id, tx));
    if (service === null) {
      throw new Error(
        `order ${order.id} settled but neither created nor found a service; the unique index is missing`,
      );
    }

    const operation = await this.deps.operations.plan(
      scope,
      {
        id: this.deps.ids.uuid(),
        operationId: this.deps.operationId(`${service.id}:PROVISION`),
        serviceId: service.id,
        orderId: order.id,
        /* The customer whose purchase this is. Recorded for the audit-adjacent fact
         * rather than for a message: `PROVISION` is answered by `DeliveryService`
         * sending the link, never by the outcome announcer. */
        requestedByCustomerId: service.customerId,
        panelId: service.panelId,
        type: 'PROVISION',
      },
      now,
      tx,
    );

    if (created !== null) {
      /*
       * Audited and announced ONLY when this call actually created the service.
       *
       * A replay that read the winner's row has changed nothing, and an audit row
       * saying it did would make a report count one purchase twice. The same reasoning
       * the payment path uses for its confirmation race.
       */
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.plan',
          entityType: 'Service',
          entityId: service.id,
          before: null,
          after: {
            orderId: order.id,
            customerId: order.customerId,
            panelId: service.panelId,
            productId: service.productId,
            state: service.state,
            operationId: operation.operationId,
          },
          result: 'SUCCESS',
        },
        tx,
      );

      /*
       * No domain event here, deliberately.
       *
       * `events.ts` declares `ServiceProvisioned`, `ServiceStateChanged` and
       * `ProvisioningOutcomeUnknown` and no "planned" member, and adding one would be a
       * contract change with no consumer: the executor finds its work by claiming from
       * `provisioning_operations`, not by subscribing. An event nothing reads is a
       * promise the catalogue makes and nothing keeps. The audit row above is the
       * record of what happened; `ServiceProvisioned` is written when a provider has
       * actually provisioned something, which is a different and later fact.
       */
    }

    return { service, operation };
  }

  /**
   * An operator asking for a stalled service to be tried again.
   *
   * The three refusals here are the whole value of the method, and each one is a state
   * an operator can otherwise only discover by watching nothing happen.
   *
   * `SERVICE_UNRECONCILED` is the refusal `SERVICE_MACHINE` encodes as a MISSING EDGE,
   * surfaced. An `UNRECONCILED` service is one whose create timed out or answered with
   * a 5xx: the panel may hold an account, and asking for another one is how a customer
   * ends up paying for one service and occupying two. The remedy is a read, and a read
   * is not something a button labelled "retry" should be allowed to skip.
   *
   * `PANEL_NOT_OPERABLE` is the panel refusing before anything is spent — disabled, no
   * adapter, no capability, no credential, no activation — with the `reason` naming
   * which screen fixes it. Answered here rather than left to the executor because an
   * operator pressing retry deserves the answer now, not in a log line after a claim.
   *
   * `ORDER_STATE_INVALID` covers a service that is already ACTIVE or TERMINATED: there
   * is nothing to provision, and planning one would produce a second provider account
   * for a service that already has one.
   */
  async retryProvisioning(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<OperationRecord> {
    await this.deps.guard.check(scope, actor, SERVICE_EDIT_PERMISSION);
    const service = await this.deps.services.findById(scope, serviceIdOrNotFound(serviceId));
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    if (service.state === 'UNRECONCILED') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_UNRECONCILED,
        'This service must be reconciled with its panel before it can be created again.',
        { reason: 'RECONCILE_FIRST' },
      );
    }
    if (service.state !== 'PENDING_PROVISION') {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'That service is not awaiting provisioning.',
        { state: service.state },
      );
    }
    const operable = await this.deps.panels.operability(scope, service.panelId, 'PROVISION');
    if (!operable.ok) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service was promised on cannot be used.',
        { reason: operable.reason },
      );
    }

    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) => {
      /*
       * The tenant must still be accepting work, checked INSIDE the transaction.
       *
       * Every sibling write path does this and this one did not — the exact omission
       * CLAUDE.md records against the panels module, where a tenant an operator had
       * stopped went on being given new panels. The executor would refuse the operation
       * later with `TENANT_STOPPED`, so the cost here is rows rather than provider
       * calls; a write path that leaves rows for a stopped tenant is still a write path
       * that ignored the switch.
       */
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'That tenant has stopped accepting work.',
        );
      }

      /*
       * An attempt already under way is RETURNED, not rivalled.
       *
       * `provisioning_operations_open_provision_key` admits one open PROVISION per
       * service, and this reads it first so the ordinary double-click gets the
       * operation that exists rather than a conflict. The index is the guarantee; this
       * is what makes the guarantee pleasant.
       */
      const open = await this.deps.operations.findOpen(scope, serviceId, 'PROVISION', tx);
      if (open !== null) return open;

      /*
       * Planned under an id DERIVED from the caller's idempotency key.
       *
       * It used to be derived from how many operations this service already had, which
       * held only for SIMULTANEOUS clicks: two clicks a moment apart read lengths n and
       * n+1, derived two different ids, and planned two creates for one service. The
       * derived username made the second collide on the panel rather than duplicate the
       * account — and a collision is a `PROVIDER_ERROR`, which classifies UNKNOWN on a
       * mutating call, which strands the service in `UNRECONCILED`. The button meant to
       * rescue a service corrupted it.
       *
       * Every state-changing command takes an idempotency key; this one is no
       * exception, and the key is what two clicks of one button share.
       */
      const operation = await this.deps.operations.plan(
        scope,
        {
          id: this.deps.ids.uuid(),
          operationId: this.deps.operationId(
            `${serviceId}:PROVISION:retry:${input.idempotencyKey}`,
          ),
          serviceId,
          orderId: service.orderId,
          /* NULL: this is the operator's retry, not the customer's purchase. */
          requestedByCustomerId: null,
          panelId: service.panelId,
          type: 'PROVISION',
        },
        now,
        tx,
      );
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.retry_provision',
          entityType: 'Service',
          entityId: serviceId,
          before: { state: service.state },
          after: { operationId: operation.operationId, operationState: operation.state },
          result: 'SUCCESS',
        },
        tx,
      );
      return operation;
    });
  }

  /*
   * The operator's own `list`, `get` and `operationsFor` were HERE, and are gone.
   *
   * They were written in 4D against `services.view`, and nothing ever called them:
   * there was no controller, no CLI and no test, which is how `docs/phase4h-audit.md`
   * §7 could measure a declared permission with no way to exercise it while three
   * authorized read methods sat in this file. 4H gave the operator a real surface, and
   * `ServiceAdminService` is that one implementation. Leaving these behind would be the
   * shape `probe-core.ts` warns about one layer up — two readers of the same rows, one
   * of them the copy nobody notices has drifted.
   *
   * `listForCustomer` and `getForCustomer` below are NOT that. They take a customer id
   * rather than a permission, and the scoping IS the authorisation.
   */

  /**
   * A customer's own services, for the Telegram surface.
   *
   * NO permission check, and a `customerId` that the caller must have established from
   * the update's own `from.id` rather than from anything a client sent. A customer is
   * not an admin and holds no permissions; the authorisation here IS the scoping, and
   * it is why this takes a customer id as a required argument instead of reading one
   * out of a search object where an empty filter would return the tenant's everything.
   */
  async listForCustomer(
    scope: TenantContext,
    customerId: UserId,
    limit = SERVICE_PAGE_DEFAULT,
    cursor: ServiceCursor | null = null,
  ): Promise<ServicePage> {
    return this.deps.services.list(
      scope,
      { customerId },
      Math.min(Math.max(limit, 1), SERVICE_PAGE_MAX),
      cursor,
    );
  }

  /**
   * One of a customer's own services, refusing anybody else's.
   *
   * The ownership check is a comparison against the row, not a filter on the query,
   * so a customer asking for an id they do not own gets `SERVICE_NOT_FOUND` — the same
   * answer as an id that does not exist. Telling them apart would let somebody
   * enumerate another tenant's service ids by watching which refusal comes back.
   */
  async getForCustomer(
    scope: TenantContext,
    customerId: UserId,
    id: string,
  ): Promise<ServiceRecord> {
    /*
     * The id is VALIDATED before it reaches a `uuid` column.
     *
     * This path is reached from Telegram callback data, which is attacker-supplied: a
     * crafted `s:<anything>` would otherwise fail at the cast rather than at the
     * ownership check, and an invalid-cast error is neither the tenancy answer nor a
     * refusal the surface has a sentence for.
     */
    // Owned, and not paid back and deleted at the customer's own request (WP19 T5): both
    // in the query, so a hidden service answers exactly like one that never existed.
    const service = await this.deps.services.findForCustomer(
      scope,
      customerId,
      serviceIdOrNotFound(id),
    );
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  /**
   * Which of the three management actions this service can actually take, right now.
   *
   * Asked by the surface so that a button is drawn only when tapping it would do
   * something. Two independent conditions, and both are real:
   *
   * - `OPERATION_LEGAL_FROM` — a resume means nothing for a service that is not
   *   suspended, and the executor would ABANDON the operation.
   * - the panel's own capability, through `operability`, which reads
   *   `OPERATION_REQUIRED_CAPABILITIES` against the descriptor. A 3X-UI-backed service
   *   yields an empty list, because this release cannot disable, re-enable or delete a
   *   client on that provider and must not offer to.
   *
   * NOT a security control, and the distinction matters: `requestFromCustomer` checks
   * ownership, the state and the capability again when the tap arrives, so a customer
   * holding an older message is refused rather than served. Not drawing the button is
   * what keeps the product honest; refusing the request is what keeps it correct.
   */
  /**
   * The customer's services by page NUMBER (customer UX completion §G). A page past the
   * last is clamped to the last, so a stale button on an old message lands on a real
   * page rather than an empty one; a customer with no services gets page 1 of 1.
   */
  async pageForCustomer(
    scope: TenantContext,
    customerId: UserId,
    pageNumber: number,
  ): Promise<{
    readonly items: readonly ServiceRecord[];
    readonly page: number;
    readonly pages: number;
    readonly count: number;
  }> {
    const size = SERVICES_LIST_PAGE_SIZE;
    const first = await this.deps.services.pageForCustomer(scope, customerId, {
      number: Math.max(1, Math.trunc(pageNumber) || 1),
      size,
    });
    const pages = Math.max(1, Math.ceil(first.count / size));
    const wanted = Math.min(Math.max(1, Math.trunc(pageNumber) || 1), pages);
    if (wanted === Math.max(1, Math.trunc(pageNumber) || 1)) {
      return { items: first.items, page: wanted, pages, count: first.count };
    }
    const clamped = await this.deps.services.pageForCustomer(scope, customerId, {
      number: wanted,
      size,
    });
    return { items: clamped.items, page: wanted, pages, count: clamped.count };
  }

  /**
   * The customer's OWN services whose username starts with the typed text. The text is
   * canonicalised the way usernames are stored (lowercase); the repository puts the
   * tenant and the customer in the WHERE.
   */
  async searchForCustomer(
    scope: TenantContext,
    customerId: UserId,
    query: string,
  ): Promise<readonly ServiceRecord[]> {
    const prefix = query.trim().toLowerCase();
    if (prefix.length === 0) return [];
    return this.deps.services.searchForCustomer(scope, customerId, prefix, SERVICES_LIST_PAGE_SIZE);
  }

  /**
   * The customer's own note on their own service (customer UX completion §H4). Bounded,
   * control characters stripped, and written with the ownership in the UPDATE's WHERE.
   * Not provider identity and not provisioning input: nothing reads it but the card.
   */
  async setCustomerNote(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    note: string | null,
  ): Promise<{ readonly changed: boolean; readonly note: string | null }> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);
    const service = await this.getForCustomer(scope, customerId, serviceId);
    const cleaned = note === null ? null : normaliseCustomerNote(note);
    if (cleaned !== null && cleaned.length === 0) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.CAPTURE_INPUT_INVALID,
        'A note is between one and the bound in length.',
        { max: SERVICE_NOTE_MAX_LENGTH },
      );
    }
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'That tenant has stopped accepting work.',
        );
      }
      const now = this.deps.clock.now();
      const changed = await this.deps.services.setCustomerNote(
        scope,
        customerId,
        service.id,
        cleaned,
        now,
        tx,
      );
      if (!changed) {
        throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
      }
      await this.deps.audit.record(
        scope,
        actor,
        {
          action: 'service.customer_note',
          entityType: 'Service',
          entityId: service.id,
          before: { note: service.customerNote },
          after: { note: cleaned },
          result: 'SUCCESS',
        },
        tx,
      );
      return { changed: service.customerNote !== cleaned, note: cleaned };
    });
  }

  /**
   * Whether the refresh button is drawn: ACTIVE, and the panel can read usage.
   * Re-decided on the tap by `requestSyncFromCustomer`.
   */
  async customerSyncOffered(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    if (!OPERATION_LEGAL_FROM.SYNC_USAGE.includes(service.state)) return false;
    if (!(await this.deps.panels.operability(scope, service.panelId, 'SYNC_USAGE')).ok) {
      return false;
    }
    return customerActionVerdict(
      await this.deps.panelPolicy.forPanel(scope, service.panelId),
      'USAGE_READ',
    ).allowed;
  }

  /**
   * «♻️ بروزرسانی اطلاعات» (customer UX completion §H1): a usage read on the panel,
   * queued through the same operation model every other panel call takes — never
   * dialled from the API process. One open `SYNC_USAGE` per service is the primary
   * dedupe (`findOpen`); the interval below covers the read that just landed, so a
   * tapped button cannot dial a panel in a loop. A failed read writes nothing to the
   * row; the outcome reaches the customer through the announcer.
   */
  async requestSyncFromCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    input: { readonly idempotencyKey: string },
  ): Promise<OperationRecord> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);
    const service = await this.getForCustomer(scope, customerId, serviceId);
    return this.planRequestedOperation(scope, actor, service, 'SYNC_USAGE', input, {
      requestedBy: customerId,
      stateRefusal: COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
      admission: {
        serialize: async (tx) => {
          if ((await this.deps.services.lockForUpdate(scope, service.id, tx)) === null) {
            throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
          }
        },
        admit: async (tx) => {
          const customer = await this.deps.customers.findById(scope, customerId, tx);
          if (customer === null || customer.status === 'BLOCKED') {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
              'This customer cannot act on their services.',
            );
          }
          const fresh = await this.deps.services.findById(scope, service.id, tx);
          const syncedAt = fresh?.usageSyncedAt ?? null;
          // WP-A8: the panel may lengthen the wait, never shorten it.
          const interval = effectiveCooldownMs(
            CUSTOMER_SYNC_MIN_INTERVAL_MS,
            await this.deps.panelPolicy.forPanel(scope, service.panelId, tx),
            'USAGE_READ',
          );
          if (
            syncedAt !== null &&
            this.deps.clock.now().getTime() - syncedAt.getTime() < interval
          ) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.SERVICE_SYNC_TOO_SOON,
              'Usage was read from the panel a moment ago.',
              { syncedAt: syncedAt.toISOString() },
            );
          }
        },
      },
    });
  }

  /**
   * Round N (F4): is a change to this service still being applied on its panel — a disable,
   * an enable, a new link or a location move that is planned, in flight, or `UNKNOWN` and
   * waiting on a read? The service card then reads «working» and offers no action, because
   * the state it would show is not final until the change is.
   *
   * Read from the operation rows (`hasUnsettled`), the record of what is happening, and not
   * from a flag the card keeps: whichever message draws the card — the one a change was asked
   * from, a card opened from the list, a refresh — draws the same truth.
   */
  async changeInProgress(scope: TenantContext, service: ServiceRecord): Promise<boolean> {
    for (const type of CARD_WORKING_OPERATIONS) {
      if (await this.deps.operations.hasUnsettled(scope, service.id, type)) return true;
    }
    return false;
  }

  /**
   * Round N (Codex review of #116): the operation a customer's request with THIS idempotency
   * key already planned, if any — the same derivation `planWithin` uses, read-only. A
   * redelivered tap is told apart from a new one with it BEFORE the service card is turned
   * «working»: a request whose operation has already ended was already answered on the card.
   */
  async findCustomerRequest(
    scope: TenantContext,
    serviceId: string,
    type: OperationType,
    idempotencyKey: string,
  ): Promise<OperationRecord | null> {
    return this.deps.operations.findByOperationId(
      scope,
      this.deps.operationId(`${serviceId}:${type}:${idempotencyKey}`),
    );
  }

  async customerActionsFor(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<readonly CustomerServiceOperation[]> {
    const available: CustomerServiceOperation[] = [];
    const policy = await this.deps.panelPolicy.forPanel(scope, service.panelId);
    for (const type of CUSTOMER_SERVICE_OPERATIONS) {
      if (!OPERATION_LEGAL_FROM[type].includes(service.state)) continue;
      const operable = await this.deps.panels.operability(scope, service.panelId, type);
      if (!operable.ok) continue;
      // WP-A8: a courtesy for drawing; `planWithin` decides again inside the transaction.
      if (!customerActionVerdict(policy, 'DISABLE_ENABLE').allowed) continue;
      available.push(type);
    }
    return available;
  }

  /**
   * Plans one management operation a CUSTOMER asked for, against their own service.
   *
   * ## Authorisation is ownership, and nothing else
   *
   * Exactly as `getForCustomer`: a customer is not an admin and holds no permissions,
   * so `customerId` is the authorisation and the caller must have established it from
   * the Telegram update's own `from.id`. The service is fetched through
   * `getForCustomer`, which compares against the ROW rather than filtering the query,
   * so somebody else's id answers `SERVICE_NOT_FOUND` — the same answer an id that does
   * not exist gets, because telling them apart lets a service id be enumerated.
   *
   * Nothing a client sends names a panel, a provider username or an operation target.
   * The type comes from which button was pressed, the service from an id the customer
   * owns, and the panel and the provider identity are read off that service's row.
   *
   * ## Four refusals, in this order, and each is the operator's or the customer's to fix
   *
   * 1. The service must be in a state the operation is legal from — `OPERATION_LEGAL_FROM`,
   *    the same table the executor checks. Checked here so the customer is told now
   *    rather than by an operation that is planned, claimed and then ABANDONED.
   * 2. The panel must be able to perform it. `operability` reads
   *    `OPERATION_REQUIRED_CAPABILITIES` against the panel's own descriptor, so a
   *    3X-UI-backed service is refused with `CAPABILITY_UNSUPPORTED` before a row
   *    exists. That refusal is the whole reason the capability list is a promise.
   * 3. The tenant must still be accepting work, checked INSIDE the transaction, because
   *    a surface checks on arrival and a stop can commit in between.
   * 4. An operation of this type already open for this service is RETURNED rather than
   *    rivalled, so the ordinary double-tap gets the one that exists.
   *
   * ## The idempotency key is the caller's, and it is what two taps share
   *
   * The operation id is derived from it. Deriving from a count of existing operations
   * is what once let two clicks a moment apart plan two creates for one service; the
   * key is the only thing that is the same for both taps of one button and different
   * for a genuine second request.
   */
  async requestFromCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    type: CustomerServiceOperation,
    input: {
      readonly idempotencyKey: string;
      /** R3: the service card the tap came from, whose result is shown on it. */
      readonly card?: CardMessageRef;
    },
  ): Promise<OperationRecord> {
    /*
     * Re-checked at run time, not only by the type (WP15 G1). A caller that is not
     * TypeScript, or a type widened by a later edit, must still not be able to plan a
     * customer TERMINATE: the list above is the policy, and this is where it is enforced.
     */
    if (!(CUSTOMER_SERVICE_OPERATIONS as readonly string[]).includes(type)) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
        'This action is not available to a customer.',
        { operation: type },
      );
    }
    const service = await this.getForCustomer(scope, customerId, serviceId);
    return this.planRequestedOperation(scope, actor, service, type, input, {
      requestedBy: customerId,
      ...(input.card === undefined ? {} : { card: input.card }),
      /*
       * The code this path has answered since 4E, kept.
       *
       * `SERVICE_ACTION_NOT_ALLOWED` is the more honest name and the operator path uses
       * it; changing this one would change what a customer is told by a shipped
       * surface, which is a product decision and not a refactor. Both are mapped in
       * `bot-runtime`'s refusal table, so the sentence is the same either way.
       */
      stateRefusal: COMMERCE_ERROR_CODES.ORDER_STATE_INVALID,
    });
  }

  /**
   * Whether this customer's service offers the rotation button, and the cooldown to show.
   *
   * WP6-C. A courtesy for drawing, exactly as `customerActionsFor`: `requestRotation`
   * re-decides every one of these when the tap arrives. Four conditions — the flag, the
   * state, the panel's operability for `ROTATE_SUBSCRIPTION` (which includes the
   * capability), and nothing else: the cooldown is NOT a reason to hide the button,
   * because a customer who cannot see it cannot be told when it comes back.
   */
  async customerRotationFor(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<CustomerRotationOffer> {
    if (!CUSTOMER_ROTATION_STATES.includes(service.state)) return { offered: false };
    if (!(await this.deps.features.isEnabled(scope, 'customer_link_rotation'))) {
      return { offered: false };
    }
    const operable = await this.deps.panels.operability(
      scope,
      service.panelId,
      'ROTATE_SUBSCRIPTION',
    );
    if (!operable.ok) return { offered: false };
    const policy = await this.deps.panelPolicy.forPanel(scope, service.panelId);
    if (!customerActionVerdict(policy, 'ROTATE_SUBSCRIPTION').allowed) return { offered: false };
    const hours = await this.deps.settings.valueOf<number>(
      scope,
      'services.link_rotation_cooldown_hours',
    );
    // WP-A8: the wait the customer is told is the one `requestRotation` enforces — the
    // longer of the tenant's and this panel's — rounded UP to whole hours, so the
    // sentence never promises a rotation sooner than it will be accepted.
    const cooldownHours = Math.ceil(
      effectiveCooldownMs(hours * 3_600_000, policy, 'ROTATE_SUBSCRIPTION') / 3_600_000,
    );
    return { offered: true, cooldownHours };
  }

  /**
   * A customer asks for a new subscription link for their own service (WP6-C).
   *
   * `docs/wp6c-audit.md` is the design. It is `requestFromCustomer` with one more
   * operation and one more rule, and it goes through the SAME planner, so the legal
   * state, the panel's operability, the scope check, the open-operation return, the
   * derived operation id and the audit row are the planner's and are not restated here.
   *
   * What this adds, in the order it runs:
   *
   * 1. The guard (`maintenance.run`), then ownership through `getForCustomer`.
   * 2. Inside the transaction, the service row lock (`serialize`). Two taps under
   *    different keys become serial here.
   * 3. After the planner has returned an open rotation or a replay of this key, the
   *    `admit` rule, on the LOCKED row: the service is `ACTIVE`, the flag is on, the
   *    customer is not blocked, and the cooldown has passed.
   *
   * The cooldown counts the customer's own rotations that SUCCEEDED, from the instant
   * each was requested. The refusal carries `availableAt`, so the customer is told when
   * rather than "later".
   */
  async requestRotation(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    serviceId: string,
    input: {
      readonly idempotencyKey: string;
      /** Round N (F4): the service card the confirmation came from; answered on it. */
      readonly card?: CardMessageRef;
    },
  ): Promise<OperationRecord> {
    await this.deps.guard.check(scope, actor, CUSTOMER_ROTATION_PERMISSION);
    const service = await this.getForCustomer(scope, customerId, serviceId);
    const stateRefusal = COMMERCE_ERROR_CODES.ORDER_STATE_INVALID;
    // The row as `serialize` locked it, read again by nothing: `admit` decides on it.
    let locked: ServiceRecord | null = null;
    return this.planRequestedOperation(scope, actor, service, 'ROTATE_SUBSCRIPTION', input, {
      requestedBy: customerId,
      ...(input.card === undefined ? {} : { card: input.card }),
      stateRefusal,
      admission: {
        serialize: async (tx) => {
          locked = await this.deps.services.lockForUpdate(scope, service.id, tx);
          if (locked === null) {
            throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
          }
        },
        admit: async (tx) => {
          if (locked === null) {
            throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
          }
          if (!CUSTOMER_ROTATION_STATES.includes(locked.state)) {
            throw errors.conflict(
              stateRefusal,
              'That service is not in a state this action can be taken from.',
              { state: locked.state },
            );
          }
          if (!(await this.deps.features.isEnabled(scope, 'customer_link_rotation', tx))) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
              'A customer cannot rotate a link on this installation.',
              { reason: 'FEATURE_DISABLED' },
            );
          }
          const customer = await this.deps.customers.findById(scope, customerId, tx);
          if (customer === null || customer.status === 'BLOCKED') {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.CUSTOMER_BLOCKED,
              'This customer cannot act on their services.',
            );
          }
          const last = await this.deps.operations.lastSucceededCustomerRequest(
            scope,
            service.id,
            customerId,
            'ROTATE_SUBSCRIPTION',
            tx,
          );
          if (last !== null) {
            const hours = await this.deps.settings.valueOf<number>(
              scope,
              'services.link_rotation_cooldown_hours',
              tx,
            );
            // WP-A8: the panel may lengthen the wait, never shorten it.
            const waitMs = effectiveCooldownMs(
              hours * 3_600_000,
              await this.deps.panelPolicy.forPanel(scope, service.panelId, tx),
              'ROTATE_SUBSCRIPTION',
            );
            const availableAt = new Date(last.getTime() + waitMs);
            if (this.deps.clock.now().getTime() < availableAt.getTime()) {
              throw errors.conflict(
                COMMERCE_ERROR_CODES.SERVICE_ROTATION_COOLDOWN,
                'This link was rotated too recently to rotate again.',
                { availableAt: availableAt.toISOString() },
              );
            }
          }
        },
      },
    });
  }

  /**
   * Plans one management operation an OPERATOR asked for, on any service in their tenant.
   *
   * Phase 6A, and the sibling of `requestFromCustomer` above. Everything about the
   * PLANNING is identical — the same legal-state table, the same panel operability, the
   * same scope-activity check inside the transaction, the same open-operation return,
   * the same operation id derived from the caller's idempotency key — and the two things
   * that differ are the two that must:
   *
   * 1. **Authorisation is a permission, not ownership.** `OPERATOR_OPERATION_PERMISSION`
   *    charges `services.terminate` for a terminate and `services.edit` for the rest,
   *    through the guard, which writes its own operational event on a denial. The
   *    service is then read by id WITHOUT a customer comparison, because an operator
   *    acts on services that are not theirs — that is the job — and the tenant scope is
   *    the isolation.
   * 2. **The actor is real.** A Telegram administrator or a Web Admin session has an
   *    `ActorContext` of its own, so the audit row names who asked rather than recording
   *    the `SYSTEM_JOB` a webhook runs as and putting the requester in the payload. That
   *    is the distinction `docs/conventions.md` draws about fabricated actors, and it is
   *    why this method takes the actor it authorises with and passes the same one to the
   *    audit writer.
   *
   * The guard runs BEFORE the service is read, so an unauthorised caller cannot learn
   * whether an id exists — the same ordering `ServiceAdminService` uses.
   */
  async requestFromOperator(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    type: OperatorServiceOperation,
    input: { readonly idempotencyKey: string },
  ): Promise<OperationRecord> {
    await this.deps.guard.check(scope, actor, OPERATOR_OPERATION_PERMISSION[type]);
    const service = await this.deps.services.findById(scope, serviceIdOrNotFound(serviceId));
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return this.planRequestedOperation(scope, actor, service, type, input, {
      requestedBy: 'OPERATOR',
    });
  }

  /**
   * The planning half both request paths share, so neither can drift from the other.
   *
   * Extracted in 6A when the operator path arrived, and `requestFromCustomer` was moved
   * ONTO it rather than left beside it: 4E's version and this one were the same four
   * refusals in the same order, and a second copy is precisely how one caller ends up
   * without the scope-activity check or without the open-operation return. Both are
   * invisible until a stopped tenant gets rows or a double-click gets two operations.
   *
   * The four refusals, their ORDER and the reason for each are documented on
   * `requestFromCustomer` above. Two things are the CALLER's and arrive in `origin`:
   * who asked, which the audit row records, and which code a state refusal answers —
   * the customer path keeps the one it has answered since 4E.
   */
  private async planRequestedOperation(
    scope: TenantContext,
    actor: ActorContext,
    service: ServiceRecord,
    type: OperationType,
    input: { readonly idempotencyKey: string },
    origin: {
      readonly requestedBy: 'OPERATOR' | UserId;
      /** R3: the card a customer's request came from (`requestFromCustomer` only). */
      readonly card?: CardMessageRef;
      /** One of exactly two codes, so a third caller cannot invent a third answer. */
      readonly stateRefusal?:
        | typeof COMMERCE_ERROR_CODES.ORDER_STATE_INVALID
        | typeof COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED;
      /**
       * A rule the caller decides INSIDE the transaction, from rows it must lock first
       * (WP6-C). `serialize` runs before anything else is read; `admit` runs after an
       * open operation and a replay of this very key have both been answered, and
       * throws its own refusal. Absent for every request path that has no such rule.
       */
      readonly admission?: {
        readonly serialize: (tx: TransactionScope) => Promise<void>;
        readonly admit: (tx: TransactionScope) => Promise<void>;
      };
    },
  ): Promise<OperationRecord> {
    const legalFrom = OPERATION_LEGAL_FROM[type];
    if (!legalFrom.includes(service.state)) {
      throw errors.conflict(
        origin.stateRefusal ?? COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is not in a state this action can be taken from.',
        { state: service.state },
      );
    }
    const operable = await this.deps.panels.operability(scope, service.panelId, type);
    if (!operable.ok) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service lives on cannot perform that action.',
        { reason: operable.reason },
      );
    }

    const now = this.deps.clock.now();
    return this.deps.uow.run(scope, async (tx) =>
      this.planWithin(scope, actor, service, type, input, origin, now, tx),
    );
  }

  /**
   * WP19: a `TERMINATE` planned INSIDE a caller's transaction.
   *
   * The one caller is an approved customer refund request, which must reserve the money
   * and plan the deletion as one fact — a request that reserved an amount with no deletion
   * behind it, or planned a deletion with nothing reserved, would each be a state no one
   * decided. Everything else about the plan is `planRequestedOperation`'s, unchanged: the
   * legal state, the panel's operability, an open TERMINATE answered rather than
   * duplicated, and the audit row naming the administrator who approved it.
   *
   * No permission check here: the caller holds `services.terminate` AND `refunds.issue`
   * and has charged both through the guard before it opened the transaction.
   */
  async planTerminateWithin(
    scope: TenantContext,
    actor: ActorContext,
    service: ServiceRecord,
    input: { readonly idempotencyKey: string },
    tx: TransactionScope,
  ): Promise<OperationRecord> {
    if (!OPERATION_LEGAL_FROM.TERMINATE.includes(service.state)) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is not in a state this action can be taken from.',
        { state: service.state },
      );
    }
    // In the caller's transaction, beside the locks it holds (Codex review of #83, round 4).
    const operable = await this.deps.panels.operability(scope, service.panelId, 'TERMINATE', tx);
    if (!operable.ok) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service lives on cannot perform that action.',
        { reason: operable.reason },
      );
    }
    return this.planWithin(
      scope,
      actor,
      service,
      'TERMINATE',
      input,
      { requestedBy: 'OPERATOR', forRefundRequest: true },
      this.deps.clock.now(),
      tx,
    );
  }

  /** The transactional half of planning, shared by both entry points above. */
  private async planWithin(
    scope: TenantContext,
    actor: ActorContext,
    service: ServiceRecord,
    type: OperationType,
    input: { readonly idempotencyKey: string },
    origin: {
      readonly requestedBy: 'OPERATOR' | UserId;
      /** R3: the card a customer's request came from (`requestFromCustomer` only). */
      readonly card?: CardMessageRef;
      readonly admission?: {
        readonly serialize: (tx: TransactionScope) => Promise<void>;
        readonly admit: (tx: TransactionScope) => Promise<void>;
      };
      /**
       * Set by `planTerminateWithin` alone: this deletion IS an approved refund request's, so
       * the request standing active is the reason for it rather than a refusal of it.
       */
      readonly forRefundRequest?: true;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<OperationRecord> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That tenant has stopped accepting work.',
      );
    }
    /*
     * The lock comes FIRST, before the open-operation read below, so that a second
     * request waiting here sees the first one's committed row rather than the world
     * both of them started from.
     */
    if (origin.admission !== undefined) await origin.admission.serialize(tx);
    /*
     * Every TERMINATE planner serialises on the service's row (WP19, Codex review of #83,
     * round 4). An approved refund request plans its deletion under that lock; an
     * operator's terminate, planned without it, could pass `findOpen` beside it and plan a
     * SECOND deletion — which fails against the account the first one removed, and the
     * request, bound to whichever ran second, is released with the service gone. Nothing
     * else keys an open TERMINATE, so the lock is the rule. Re-taking it in the approval's
     * own transaction is a no-op. The state is judged again from the locked row: the one
     * read before the wait may predate a deletion that has since finished.
     */
    if (type === 'TERMINATE') {
      const locked = await this.deps.services.lockForUpdate(scope, service.id, tx);
      if (locked === null || !OPERATION_LEGAL_FROM.TERMINATE.includes(locked.state)) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
          'That service is not in a state this action can be taken from.',
          { state: locked?.state ?? null },
        );
      }
      /*
       * Then the lifecycle lock, after the row (Codex review of #83, round 11). A paid
       * commercial action's settlement refuses while a deletion is undecided, and it decides
       * that under this lock alone — it never takes the service row, because it already holds
       * the customer's wallet there. A deletion planned under the row lock only could pass
       * that settlement's check and its own `findOpen` beside it, and delete the renewal the
       * customer had just paid for. Nothing waits on another lock while holding this one.
       */
      await this.deps.services.lockLifecycle(scope, locked.id, tx);
      /*
       * A customer's refund request for this service is OPEN (Codex review of #83, round 11).
       * Its approval deletes the service and credits the wallet; a deletion planned beside it
       * would remove the service with no credit behind it, and leave the request OPEN for
       * ever, since an approval refuses a service that has ended. The operator decides the
       * request instead. An EXECUTING request is not refused here: its own deletion is
       * already planned, and the sweep credits it whichever deletion removes the service.
       * Its approval, which plans that deletion, passes `forRefundRequest`.
       */
      if (
        origin.forRefundRequest !== true &&
        (await this.deps.services.hasOpenRefundRequest(scope, locked.id, tx))
      ) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
          'This service has a refund request pending; decide the request instead.',
          { state: locked.state, reason: 'REFUND_REQUESTED' },
        );
      }
    }
    /*
     * WP-A6: a rotation and a location move exclude each other (Codex review #2 on
     * PR #101) — both end by storing the link the panel serves, and two in flight could
     * leave the older one stored. The lifecycle lock is the one `prepareCommercialAction`
     * asks the mirror question under; taken last, after any row lock, as every planner
     * takes it. An open rotation, and a replay of this key, are still RETURNED first.
     */
    if (type === 'ROTATE_SUBSCRIPTION')
      await this.deps.services.lockLifecycle(scope, service.id, tx);
    const open = await this.deps.operations.findOpen(scope, service.id, type, tx);
    if (open !== null) return open;
    const operationId = this.deps.operationId(`${service.id}:${type}:${input.idempotencyKey}`);
    if (origin.admission !== undefined) {
      /*
       * A replay of this key is answered with what it planned, BEFORE the admission
       * rule: the request that started a cooldown must not be refused by its own
       * success when its webhook is delivered again.
       */
      const replay = await this.deps.operations.findByOperationId(scope, operationId, tx);
      if (replay !== null) return replay;
      await origin.admission.admit(tx);
    }
    /*
     * WP-A8: a CUSTOMER's request is held to the panel's operator policy, here, inside
     * the transaction every customer-originated operation is planned in — the one place
     * that decision is made. After a replay of this key has been answered, so a request
     * accepted before the policy changed still returns what it planned. An operator's
     * request, and the system's, never reach this: the policy is about what customers
     * are offered, not about what the installation may do to a service.
     */
    const policyRow = CUSTOMER_OPERATION_POLICY_ROW[type];
    if (origin.requestedBy !== 'OPERATOR' && policyRow !== undefined) {
      const replay = await this.deps.operations.findByOperationId(scope, operationId, tx);
      if (replay !== null) return replay;
      assertCustomerPolicyAllows(
        await this.deps.panelPolicy.forPanel(scope, service.panelId, tx),
        policyRow,
      );
    }
    // WP-A6: after the open-rotation return and the replay, so neither is refused by the
    // rule.
    if (
      type === 'ROTATE_SUBSCRIPTION' &&
      (await this.deps.operations.hasUnsettled(scope, service.id, 'CHANGE_LOCATION', tx))
    ) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
        'This service is being moved to another location; try again once it has moved.',
      );
    }
    const operation = await this.deps.operations.plan(
      scope,
      {
        id: this.deps.ids.uuid(),
        operationId,
        serviceId: service.id,
        orderId: service.orderId,
        /*
         * The one place the two request paths differ in the ROW they write.
         *
         * `requestedBy` already distinguishes them in the audit payload; this puts
         * the same distinction on the operation, where the announcer can read it in
         * a later transaction. Without it the announcer decides from the TYPE, and an
         * operator's suspend is the same type as a customer's — so the customer was
         * told that the request they made had been applied, having made none.
         */
        requestedByCustomerId: origin.requestedBy === 'OPERATOR' ? null : origin.requestedBy,
        panelId: service.panelId,
        type,
      },
      now,
      tx,
    );
    /*
     * R3: the card, beside the operation it answers, in the same transaction — so the
     * provisioner can never see the operation without it. Only reached for a NEWLY
     * planned operation: an open one and a replay returned above keep the first card.
     */
    if (origin.card !== undefined && origin.requestedBy !== 'OPERATOR') {
      await this.deps.cards?.attach(scope, operation.id, origin.card, now, tx);
    }
    /*
     * WHO asked, and when.
     *
     * `plan` records no actor — an operation row says what is to be done and by which
     * worker it was claimed, not who wanted it — so without this the only answer to
     * "who asked for this service to be deleted" would be inferred. Inference is what
     * `/admin/logs` offered, and the research records what that was worth.
     *
     * The actor is whatever the CALLER authenticated. For an operator it is their own
     * `ActorContext`, which is the point of `requestFromOperator`. For a customer it
     * is the `SYSTEM_JOB` the webhook runs as, because a customer is not an admin and
     * has no actor of their own — their id goes in `requestedBy`, where it is a fact
     * about the request rather than a fabricated identity. That distinction is the
     * reason `docs/conventions.md` forbids inventing actors, and `requestedBy` is what
     * keeps the two readable apart: a customer id, or the literal `OPERATOR` beside an
     * admin actor that names the person.
     *
     * The executor writes a SECOND audit row when the panel actually applies the
     * change, and the two are different facts: this one is a decision, that one is an
     * effect, and a terminate that was asked for and never carried out must not look
     * like one that was.
     */
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: `service.request_${type.toLowerCase()}`,
        entityType: 'Service',
        entityId: service.id,
        before: { state: service.state },
        after: { requestedBy: origin.requestedBy, operationId: operation.operationId },
        result: 'SUCCESS',
      },
      tx,
    );
    return operation;
  }

  /**
   * Whether a settled COMMERCIAL order can be applied, without throwing if it cannot.
   *
   * Codex M1 on PR #50, and the same defect C4 fixed for a new service, still live on
   * the other branch. `confirmAndSettle` skipped `prepareFulfilment` entirely for
   * `RENEW`, `ADD_TRAFFIC` and `ADD_TIME` — those orders create no service and consume
   * no slot, which is true and was the wrong conclusion. `planCommercialAction` has
   * three refusals of its own, all of which can become true in the window between a
   * customer's confirmation and an operator's review of their bank transfer:
   *
   *   - the service left a state the action is legal from (terminated, expired),
   *   - the panel it lives on stopped being operable for that action,
   *   - another commercial action for the same service is still outstanding.
   *
   * Each threw, which rolled the settlement back and left a bank transfer that had
   * already arrived as a `PENDING` payment — neither confirmable nor refundable. So the
   * three checks live here, and the caller says what an ineligible answer means to it:
   * `REFUSE` keeps the old behaviour for money that has not irreversibly moved, and
   * `REFUND` confirms the payment and gives the money back.
   *
   * The third refusal is TRANSIENT, and refunding is still the answer. The
   * alternative is holding a customer's money against an action that MIGHT become
   * possible when somebody else's finishes — which is a wait with no deadline and
   * nobody watching it. A refunded customer can buy the same renewal again a minute
   * later, and the outstanding action is by then either applied or refunded too.
   */
  async prepareCommercialAction(
    scope: TenantContext,
    action: {
      readonly serviceId: string;
      readonly kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION';
      /** The ORDER's customer: the payer, who must still own the service. */
      readonly customerId: UserId;
      /** WP-A5: extra users / devices bought; zero for every other kind. */
      readonly purchasedDeviceCount?: number;
      /**
       * WP-A6, `CHANGE_LOCATION` only: where the move goes — the key itself for a free
       * change, or the ORDER whose frozen change request names it for a paid one.
       */
      readonly targetLocationKey?: string;
      readonly orderId?: OrderId;
    },
    tx: TransactionScope,
    onIneligible: 'REFUSE' | 'REFUND',
  ): Promise<
    | { readonly outcome: 'FULFILLABLE' }
    | { readonly outcome: 'UNFULFILLABLE'; readonly reason: string }
  > {
    const refuse = (
      code: string,
      message: string,
      reason: string,
    ): { readonly outcome: 'UNFULFILLABLE'; readonly reason: string } => {
      if (onIneligible === 'REFUND') return { outcome: 'UNFULFILLABLE', reason };
      throw errors.conflict(code, message, { reason });
    };

    /*
     * The lifecycle lock first, so a refund request's approval — which plans a deletion
     * under the same lock — is either wholly before this or wholly after it (Codex review of
     * #83, round 9). Taken after every lock settlement already holds.
     */
    await this.deps.services.lockLifecycle(scope, action.serviceId, tx);

    const service = await this.deps.services.findById(scope, action.serviceId, tx);
    if (service === null) {
      /*
       * Unreachable and still not stranded: `service_commercial_actions_service_fk`
       * requires the row, so its absence is a broken database rather than a condition
       * an operator could retry out of. Throwing is the honest answer to a state that
       * cannot happen.
       */
      throw new Error(`commercial action names service ${action.serviceId}, which is not there`);
    }

    /*
     * The payer no longer owns the service (Package F). A renewal or an add-on is bought for
     * one's own service; an order confirmed in the moment a transfer committed — the
     * confirmation reads the service without a lock — names a service that is now somebody
     * else's, and applying it would spend the payer's money on another customer's account.
     * Read after the lifecycle lock a transfer also takes, so a transfer is wholly before
     * this or wholly after it. Refused like every refusal here: a wallet purchase is not
     * taken, and money that already arrived is given back through the one credit path.
     */
    if (service.customerId !== action.customerId) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is no longer owned by the customer who bought this action.',
        'SERVICE_NOT_OWNED',
      );
    }

    if (!OPERATION_LEGAL_FROM[action.kind].includes(service.state)) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is not in a state this action can be taken from.',
        `SERVICE_${service.state}`,
      );
    }

    const operable = await this.deps.panels.operability(scope, service.panelId, action.kind, tx);
    if (!operable.ok) {
      return refuse(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service lives on cannot perform that action.',
        operable.reason ?? 'UNKNOWN',
      );
    }

    /*
     * WP-A5: extra users are computed from the limit the service RECORDS, so a service with
     * none recorded — or a quantity that would take it past the bound — cannot be given
     * them. Refused here, before the order's state is chosen, like every refusal above.
     */
    if (
      action.kind === 'ADD_DEVICES' &&
      extendedDeviceLimit(service.deviceLimit, action.purchasedDeviceCount ?? 0) === null
    ) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service cannot be given that many more users.',
        'DEVICE_LIMIT_UNAVAILABLE',
      );
    }

    /*
     * WP-A6: a move to where the account already is buys nothing. The quote refused it
     * against the location then recorded; this is the same question asked again when the
     * money moves, because another change can land in between — and a transfer that
     * already arrived is then given back rather than spent on a no-op.
     */
    if (action.kind === 'CHANGE_LOCATION') {
      const targetKey =
        action.targetLocationKey ??
        (action.orderId === undefined
          ? null
          : ((await this.deps.locationChanges.findByOrderId(scope, action.orderId, tx))
              ?.toLocationKey ?? null));
      if (targetKey === null) {
        // `service_location_changes` is written with the order; its absence is a broken
        // database, which no refund or retry would repair.
        throw new Error(`location change for service ${service.id} names no target`);
      }
      if (service.locationKey === targetKey) {
        return refuse(
          COMMERCE_ERROR_CODES.LOCATION_CHANGE_SAME_LOCATION,
          'The service is already in that location.',
          'LOCATION_UNCHANGED',
        );
      }
      /*
       * A move and a link rotation both end by storing the link the panel then serves, so
       * two in flight together could leave the OLDER one stored (Codex review #2 on
       * PR #101). They exclude each other in both directions under this lifecycle lock:
       * the rotation planner takes the same lock and asks the mirror question.
       */
      if (await this.deps.operations.hasUnsettled(scope, service.id, 'ROTATE_SUBSCRIPTION', tx)) {
        return refuse(
          COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
          'This service has a new link being made; try again once it is delivered.',
          'ROTATION_IN_PROGRESS',
        );
      }
    }

    const outstanding = await this.deps.operations.findOpenCommercial(scope, service.id, tx);
    if (outstanding !== null) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
        'This service already has an action waiting to be applied.',
        'ACTION_IN_PROGRESS',
      );
    }

    /*
     * A deletion is planned and not yet decided — an approved refund request's, or an
     * operator's (Codex review of #83, round 9). Whatever this action applied, the deletion
     * would take away, and the refund returns only the service's own purchase, so the
     * payment for this action would buy nothing. Refused, so a wallet purchase is not taken
     * and a transfer that already arrived is given back, like every other refusal here.
     */
    if (await this.deps.operations.terminationUndecided(scope, service.id, tx)) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'This service is being deleted.',
        'TERMINATION_PENDING',
      );
    }

    /*
     * A customer's refund request is open or being carried out (Codex review of #83, round
     * 10). Its approval deletes the service and refunds only the service's own purchase, so a
     * renewal or add-on sold now would be value the customer pays for and then loses, whether
     * it is applied before the approval or after it. Sold again once the request is decided.
     */
    if (await this.deps.services.hasActiveRefundRequest(scope, service.id, tx)) {
      return refuse(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'This service has a refund request pending.',
        'REFUND_REQUESTED',
      );
    }

    return { outcome: 'FULFILLABLE' };
  }

  /**
   * Plans the operation a settled COMMERCIAL order bought.
   *
   * Called from inside the settling transaction, exactly where `planForSettledOrder` is
   * called for a purchase, and it is the other half of the dispatch that phase 4F
   * added: `confirmAndSettle` used to reach the provisioning path unconditionally, so a
   * renewal would have settled and then created a second provider account the customer
   * did not buy.
   *
   * ## The target is computed HERE, once
   *
   * Against the service as it stands in this transaction — the money has just moved and
   * nothing else can be reading it — and then stored on the operation row and never
   * recomputed. That is the whole basis on which `RENEW`, `ADD_TRAFFIC` and `ADD_TIME`
   * are in `IDEMPOTENT_MUTATIONS`: a target derived when the worker runs would differ
   * between an attempt and its replay, and thirty days would become sixty.
   *
   * `extendedExpiry` and `extendedAllowance` are the contract's, not this file's. Both
   * carry the reasoning for their arithmetic — `max(current, now) + days` so renewing
   * early is never a punishment and renewing late never sells an elapsed period, and a
   * strictly additive allowance because the legacy answer is a five-valued per-panel
   * enum whose live value nobody could read (`OQ-4F-01`).
   *
   * ## No provider call, no network
   *
   * Two rows are written and the `provisioner` role picks the work up afterwards,
   * outside every transaction. The same shape a purchase has, for the same reason.
   */
  async planCommercialAction(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    action: {
      readonly serviceId: string;
      readonly kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME' | 'ADD_DEVICES' | 'CHANGE_LOCATION';
      readonly purchasedTrafficBytes: bigint;
      readonly purchasedDurationDays: number;
      /** WP-A5: extra users / devices bought; zero for every other kind. */
      readonly purchasedDeviceCount: number;
    },
    now: Date,
    tx: TransactionScope,
    onIneligible: 'REFUSE' | 'REFUND' = 'REFUSE',
  ): Promise<
    | { readonly outcome: 'PLANNED'; readonly operation: OperationRecord }
    | { readonly outcome: 'UNFULFILLABLE'; readonly reason: string }
  > {
    /*
     * The three settlement-time refusals, in ONE implementation — asked a SECOND
     * time, and the caller's disposition carried into the answer.
     *
     * `prepareCommercialAction` owns them because `confirmAndSettle` has to ask the
     * same question BEFORE it decides how to settle: a bank transfer that has already
     * arrived is recorded and owed rather than rolled back.
     *
     * ## Why the disposition is a parameter and not `REFUSE`
     *
     * Under READ COMMITTED this second call takes a FRESH snapshot, so it can
     * disagree with the first: a settlement for another order on the same service,
     * committed in between, is invisible to the first read and visible to this one.
     * Hard-coding `REFUSE` meant that disagreement threw — unwinding a transaction
     * that had already confirmed a bank transfer and left the arrived money as a
     * `PENDING` payment, which is the exact state the two-outcome design exists to
     * make unreachable. Reported by Codex on PR #50 against the `STRAND` design, and
     * it outlived the design it was written against.
     *
     * So the caller says what an ineligible answer MEANS to it. `REFUSE` is still the
     * default and still throws, because a wallet settlement dies with its transaction
     * and a credit for money that never left would be wrong. A bank transfer passes
     * `REFUND`, gets a verdict instead of an exception, and gives the money back.
     */
    const usable = await this.prepareCommercialAction(
      scope,
      {
        serviceId: action.serviceId,
        kind: action.kind,
        customerId: order.customerId,
        purchasedDeviceCount: action.purchasedDeviceCount,
        orderId: order.id,
      },
      tx,
      onIneligible,
    );
    if (usable.outcome !== 'FULFILLABLE') {
      if (onIneligible === 'REFUSE') {
        throw new Error('prepareCommercialAction returned UNFULFILLABLE under REFUSE');
      }
      return usable;
    }

    const service = await this.deps.services.findById(scope, action.serviceId, tx);
    if (service === null) {
      throw new Error(`order ${order.id} names service ${action.serviceId}, which is not there`);
    }

    /*
     * What the panel should end up holding, from what was bought plus what the service
     * holds now.
     *
     * `null` where the purchase bought nothing of that kind, which is the same meaning
     * the column, the provider plan and the adapter's omitted key all carry — so the
     * three agree without anybody translating between them.
     */
    /*
     * WP-A5: an `ADD_DEVICES` target is the limit the service records plus what was
     * bought, and nothing else. `prepareCommercialAction` above refused the purchase when
     * that number cannot exist, under this same lock, so the null arm is unreachable — and
     * refused rather than asserted, because the database would refuse the row anyway.
     */
    const deviceTarget =
      action.kind === 'ADD_DEVICES'
        ? extendedDeviceLimit(service.deviceLimit, action.purchasedDeviceCount)
        : null;
    if (action.kind === 'ADD_DEVICES' && deviceTarget === null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service cannot be given that many more users.',
      );
    }
    /*
     * WP-A6: a paid move's target is the key its change request froze when it was quoted,
     * and nothing else. `prepareCommercialAction` above read the same row and refused a
     * move to where the account already is, under this same lock.
     */
    const locationTarget =
      action.kind === 'CHANGE_LOCATION'
        ? ((await this.deps.locationChanges.findByOrderId(scope, order.id, tx))?.toLocationKey ??
          null)
        : null;
    if (action.kind === 'CHANGE_LOCATION' && locationTarget === null) {
      throw new Error(`order ${order.id} is a location change with no change request`);
    }
    const target: OperationTarget =
      action.kind === 'CHANGE_LOCATION'
        ? {
            expiresAt: null,
            trafficLimitBytes: null,
            deviceLimit: null,
            locationKey: locationTarget,
          }
        : action.kind === 'ADD_DEVICES'
          ? { expiresAt: null, trafficLimitBytes: null, deviceLimit: deviceTarget }
          : {
              expiresAt:
                action.purchasedDurationDays > 0
                  ? extendedExpiry(service.expiresAt, now, action.purchasedDurationDays)
                  : null,
              trafficLimitBytes:
                action.purchasedTrafficBytes > 0n || action.kind === 'RENEW'
                  ? extendedAllowance(service.trafficLimitBytes, action.purchasedTrafficBytes)
                  : null,
              deviceLimit: null,
            };

    /*
     * An allowance that cannot survive the wire.
     *
     * `MAX_TRAFFIC_BYTES` bounds what a single PRODUCT or add-on may specify, and
     * nothing bounded the CUMULATIVE figure — so enough legitimate purchases push a
     * target past `Number.MAX_SAFE_INTEGER`. The adapter serialises `data_limit` through
     * `Number`, which rounds it, and `appliedPlan` verifies the panel's answer through
     * the same lossy conversion and therefore accepts the rounded value. Nexa would then
     * store the exact bigint and diverge from the panel silently, which is the one
     * failure mode this phase's whole response-verification exists to prevent.
     *
     * Refused at the same bound a product may specify — 1 PiB, far past any real plan
     * and comfortably inside 2^53, so every value that gets past here converts exactly.
     * A refusal rather than a clamp: a clamp would sell a customer an allowance and give
     * them a smaller one.
     */
    if (target.trafficLimitBytes !== null && target.trafficLimitBytes > MAX_TRAFFIC_BYTES) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That purchase would take this service past the largest allowance this system can hold.',
        { state: service.state },
      );
    }

    if (
      target.expiresAt === null &&
      target.trafficLimitBytes === null &&
      target.deviceLimit === null &&
      (target.locationKey ?? null) === null
    ) {
      /*
       * A purchase that asks the panel for nothing.
       *
       * Reachable only for a renewal of an unlimited-in-both-directions service, which
       * `quoteRenewal`'s shape check already refuses — and refused again here, because
       * `provisioning_operations_target_present_check` would reject the row anyway and
       * a named conflict is better than an integrity violation reported as a 500.
       */
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'That purchase would not change anything about this service.',
      );
    }

    /*
     * The INSERT can lose the same race the read above just won, and that loss has to
     * reach the caller as the same verdict.
     *
     * `provisioning_operations_open_commercial_key` admits one open commercial action
     * per service, and the repository turns a loss on it into a NAMED refusal rather
     * than an idempotent win — correctly, because the loser asked for a renewal and
     * the winner may be somebody else's top-up. But under READ COMMITTED both callers
     * can pass `findOpenCommercial` before either row exists, so for a bank transfer
     * the refusal used to arrive as a throw AFTER the disposition had already been
     * honoured one statement earlier. The transfer had arrived; the transaction
     * unwound anyway. Codex found the read half of this and then, a round later, that
     * the fix stopped at the read.
     *
     * The conflict is a domain error rather than a raw `23505` — the insert is
     * `ON CONFLICT DO NOTHING` and the refusal is raised from a read that follows —
     * so the transaction is still usable here and this catch is not swallowing an
     * aborted one. Anything that is NOT that refusal rethrows untouched.
     */
    let operation: OperationRecord;
    try {
      operation = await this.deps.operations.plan(
        scope,
        {
          id: this.deps.ids.uuid(),
          /*
           * Derived from the ORDER, which is what makes a replayed settlement plan the
           * same operation rather than a second one. The order id is the only thing that
           * is the same for both attempts and different for a genuine second purchase.
           */
          operationId: this.deps.operationId(`${service.id}:${action.kind}:${order.id}`),
          serviceId: service.id,
          orderId: order.id,
          /* The customer bought this. They are owed the outcome, and this is what says so. */
          requestedByCustomerId: service.customerId,
          panelId: service.panelId,
          type: action.kind,
          target,
        },
        now,
        tx,
      );
    } catch (error) {
      if (onIneligible === 'REFUND' && isActionInProgress(error)) {
        return { outcome: 'UNFULFILLABLE', reason: 'ACTION_IN_PROGRESS' };
      }
      throw error;
    }

    await this.deps.audit.record(
      scope,
      actor,
      {
        action: `service.plan_${action.kind.toLowerCase()}`,
        entityType: 'Service',
        entityId: service.id,
        before: {
          state: service.state,
          expiresAt: service.expiresAt?.toISOString() ?? null,
          trafficLimitBytes: service.trafficLimitBytes.toString(),
          deviceLimit: service.deviceLimit,
        },
        after: {
          orderId: order.id,
          customerId: order.customerId,
          operationId: operation.operationId,
          targetExpiresAt: target.expiresAt?.toISOString() ?? null,
          targetTrafficLimitBytes: target.trafficLimitBytes?.toString() ?? null,
          targetDeviceLimit: target.deviceLimit,
          ...(action.kind === 'CHANGE_LOCATION'
            ? { fromLocationKey: service.locationKey, targetLocationKey: target.locationKey }
            : {}),
        },
        result: 'SUCCESS',
      },
      tx,
    );

    return { outcome: 'PLANNED', operation };
  }

  /**
   * Plans a FREE location change's operation (WP-A6), inside the request's transaction.
   *
   * No order and no money: a free move is asked for, not bought, so there is nothing to
   * settle and nothing a failure could refund. Everything else is the paid move's — the
   * same `prepareCommercialAction` refusals (owner, state, panel, a move to where the
   * account already is, another commercial action open, a deletion or a refund request
   * pending), asked with `REFUSE` because no money has moved, and the same one-open-
   * commercial-action index, whose loss on a race arrives as the same named refusal.
   *
   * The operation id is derived from the change request's id, so a replayed request
   * plans the same operation rather than a second one.
   */
  async planLocationChange(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly locationKey: string;
      readonly changeId: string;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<OperationRecord> {
    await this.prepareCommercialAction(
      scope,
      {
        serviceId: input.serviceId,
        kind: 'CHANGE_LOCATION',
        customerId: input.customerId,
        targetLocationKey: input.locationKey,
      },
      tx,
      'REFUSE',
    );
    const service = await this.deps.services.findById(scope, input.serviceId, tx);
    if (service === null) {
      throw new Error(`location change names service ${input.serviceId}, which is not there`);
    }
    const operation = await this.deps.operations.plan(
      scope,
      {
        id: this.deps.ids.uuid(),
        operationId: this.deps.operationId(`${service.id}:CHANGE_LOCATION:${input.changeId}`),
        serviceId: service.id,
        orderId: null,
        // The customer asked for this, so they are owed its outcome.
        requestedByCustomerId: service.customerId,
        panelId: service.panelId,
        type: 'CHANGE_LOCATION',
        target: {
          expiresAt: null,
          trafficLimitBytes: null,
          deviceLimit: null,
          locationKey: input.locationKey,
        },
      },
      now,
      tx,
    );
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: 'service.plan_change_location',
        entityType: 'Service',
        entityId: service.id,
        before: { state: service.state, locationKey: service.locationKey },
        after: {
          customerId: service.customerId,
          operationId: operation.operationId,
          targetLocationKey: input.locationKey,
          orderId: null,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    return operation;
  }

  /**
   * Round N (B2): plans ONE service's share of a mass traffic or time grant — a FREE
   * `ADD_TRAFFIC` / `ADD_TIME` operation through the path a purchased add-on takes, so the
   * provisioner executes it exactly as it executes a paid one and no new provider write path
   * exists. Called inside the bulk item's transaction.
   *
   * The same refusals as a purchase (`prepareCommercialAction`: owner, state, operability, an
   * open commercial action, a pending deletion or refund request), asked as a VERDICT because
   * no money moves here, plus the two a grant has of its own: a service with no limit in that
   * dimension cannot be given more of it, and a target past what a panel can hold is refused
   * rather than clamped. The target is absolute and computed HERE, once, against the service
   * under its lifecycle lock — the basis on which the provisioner may retry an uncertain
   * write of it and must never re-plan it.
   *
   * No order, and nobody asked: `requested_by_customer_id` is null, so the outcome announcer
   * tells the customer nothing about a "request". The bulk lane tells them, once the
   * operation has SUCCEEDED, if the operator chose to. The operation id derives from the
   * grant and the service, so a replayed item plans the same operation, not a second one.
   */
  async planGrant(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly serviceId: string;
      readonly customerId: UserId;
      readonly kind: 'ADD_TRAFFIC' | 'ADD_TIME';
      readonly trafficBytes: bigint;
      readonly durationDays: number;
      /** The bulk operation's id: one grant, one operation per service. */
      readonly grantKey: string;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<
    | { readonly outcome: 'PLANNED'; readonly operation: OperationRecord }
    | { readonly outcome: 'UNFULFILLABLE'; readonly reason: string }
  > {
    const usable = await this.prepareCommercialAction(
      scope,
      { serviceId: input.serviceId, kind: input.kind, customerId: input.customerId },
      tx,
      // A verdict, not a refund: nothing was paid. 'REFUND' is the disposition that answers
      // instead of throwing.
      'REFUND',
    );
    if (usable.outcome !== 'FULFILLABLE') return usable;
    const service = await this.deps.services.findById(scope, input.serviceId, tx);
    if (service === null) {
      throw new Error(`grant names service ${input.serviceId}, which is not there`);
    }
    let target: OperationTarget;
    if (input.kind === 'ADD_TIME') {
      const expiresAt = extendedExpiry(service.expiresAt, now, input.durationDays);
      if (expiresAt === null) return { outcome: 'UNFULFILLABLE', reason: 'UNLIMITED' };
      target = { expiresAt, trafficLimitBytes: null, deviceLimit: null };
    } else {
      if (service.trafficLimitBytes === 0n)
        return { outcome: 'UNFULFILLABLE', reason: 'UNLIMITED' };
      const limit = extendedAllowance(service.trafficLimitBytes, input.trafficBytes);
      if (limit > MAX_TRAFFIC_BYTES) return { outcome: 'UNFULFILLABLE', reason: 'LIMIT_EXCEEDED' };
      target = { expiresAt: null, trafficLimitBytes: limit, deviceLimit: null };
    }
    let operation: OperationRecord;
    try {
      operation = await this.deps.operations.plan(
        scope,
        {
          id: this.deps.ids.uuid(),
          operationId: this.deps.operationId(`${service.id}:${input.kind}:grant:${input.grantKey}`),
          serviceId: service.id,
          orderId: null,
          requestedByCustomerId: null,
          panelId: service.panelId,
          type: input.kind,
          target,
        },
        now,
        tx,
      );
    } catch (error) {
      if (isActionInProgress(error))
        return { outcome: 'UNFULFILLABLE', reason: 'ACTION_IN_PROGRESS' };
      throw error;
    }
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: `service.plan_grant_${input.kind.toLowerCase()}`,
        entityType: 'Service',
        entityId: service.id,
        before: {
          state: service.state,
          expiresAt: service.expiresAt?.toISOString() ?? null,
          trafficLimitBytes: service.trafficLimitBytes.toString(),
        },
        after: {
          grant: input.grantKey,
          operationId: operation.operationId,
          targetExpiresAt: target.expiresAt?.toISOString() ?? null,
          targetTrafficLimitBytes: target.trafficLimitBytes?.toString() ?? null,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    return { outcome: 'PLANNED', operation };
  }

  /** Whether a service is in a state where re-sending its configuration means anything. */
  static isDeliverable(service: ServiceRecord): boolean {
    const live: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];
    return live.includes(service.state) && service.subscriptionUrl !== null;
  }
}

/** The order line's device limit as the service may record it: within the bound, or none. */
function recordableDeviceLimit(limit: number | null): number | null {
  return limit !== null && limit >= 1 && limit <= MAX_DEVICE_LIMIT ? limit : null;
}

/** Kept honest: the sentinel the schema stores for an unlimited allowance is zero. */
export const UNLIMITED_TRAFFIC_SENTINEL = UNLIMITED_TRAFFIC_BYTES;

/**
 * A note as stored: trimmed, control characters and line breaks collapsed to spaces,
 * cut at the bound in CODE POINTS (never inside a surrogate pair).
 */
export function normaliseCustomerNote(raw: string): string {
  const flat = raw
    .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  return Array.from(flat).slice(0, SERVICE_NOTE_MAX_LENGTH).join('');
}

/**
 * Round N (Codex review of #116): an operation that has ended — SUCCEEDED, ABANDONED, or
 * FAILED with no retry scheduled (the announcer's own "terminal failure").
 */
export function operationHasEnded(
  operation: Pick<OperationRecord, 'state' | 'nextAttemptAt'>,
): boolean {
  return (
    operation.state === 'SUCCEEDED' ||
    operation.state === 'ABANDONED' ||
    (operation.state === 'FAILED' && operation.nextAttemptAt === null)
  );
}
