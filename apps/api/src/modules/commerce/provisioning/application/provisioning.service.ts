import {
  COMMERCE_ERROR_CODES,
  extendedAllowance,
  extendedExpiry,
  errors,
  MAX_TRAFFIC_BYTES,
  SUBSCRIPTION_REF_BYTES,
  providerUsernameFor,
  SERVICE_PAGE_MAX,
  UNLIMITED_TRAFFIC_BYTES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationId,
  type OperationTarget,
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
   * The holder of the panel slot this order took at confirmation.
   *
   * Settlement is where that hold becomes a service, and the handover happens in
   * this transaction or not at all — see `planForSettledOrder`.
   */
  readonly panelSales: PanelSalesGate;
}

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
 * Three, and the list is here rather than in `@nexa/contracts` because it is a product
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
  'TERMINATE',
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
 */
export const OPERATOR_SERVICE_OPERATIONS = [
  'SUSPEND',
  'RESUME',
  'TERMINATE',
  'SYNC_USAGE',
  'RECONCILE',
] as const satisfies readonly OperationType[];

export type OperatorServiceOperation = (typeof OPERATOR_SERVICE_OPERATIONS)[number];

/**
 * Which permission each operator operation charges.
 *
 * `TERMINATE` is `services.terminate` — a HIGH-risk key held by `owner` alone in the
 * frozen role catalogue — because it deletes the account on somebody's panel while the
 * customer keeps the order they paid for. The other four are `services.edit`.
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
};

export class ProvisioningService {
  constructor(private readonly deps: ProvisioningServiceDeps) {}

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
   */
  async planForSettledOrder(
    scope: TenantContext,
    actor: ActorContext,
    order: OrderRecord,
    now: Date,
    tx: TransactionScope,
  ): Promise<{ readonly service: ServiceRecord; readonly operation: OperationRecord }> {
    /*
     * The slot handover, and the LAST chance to refuse.
     *
     * Read first, because whether a service already exists decides everything
     * below: an order that has one is a replayed settlement, and a replay must
     * not be re-judged. The panel may have filled up or been disabled since, and
     * refusing here would roll back a transaction whose money has already moved,
     * for a customer who already has what they paid for.
     *
     * `consume` takes the panel's lock, deletes the order's hold, and — on a
     * first settlement only — decides eligibility again with that hold no longer
     * counted. Releasing before counting is what stops the order's own
     * reservation refusing the order's own service on the last slot; the lock is
     * held across the gap and the service is written before this transaction
     * commits, so nothing else can see it free.
     *
     * The refusal is a rollback, and that is the honest outcome: an installation
     * that cannot deliver must not keep the money. `AT_CAPACITY` here is
     * unreachable through the ordinary path — the slot was reserved at
     * confirmation — and reachable through the ones that matter: an operator who
     * archived the panel, a monitor that confirmed it down, or a hold that
     * lapsed because the customer paid after their own deadline.
     */
    const alreadyProvisioned =
      (await this.deps.services.findByOrderId(scope, order.id, tx)) !== null;
    const eligible = await this.deps.panelSales.consume(
      scope,
      order.line.panelId,
      order.id,
      tx,
      alreadyProvisioned,
    );
    if (!eligible.eligible) {
      throw errors.preconditionFailed(
        COMMERCE_ERROR_CODES.PANEL_NOT_ELIGIBLE,
        'This order cannot be fulfilled on its panel.',
        { reason: eligible.reason },
      );
    }

    const serviceId = this.deps.ids.uuid();
    const created = await this.deps.services.create(
      scope,
      {
        id: serviceId,
        customerId: order.customerId,
        orderId: order.id,
        panelId: order.line.panelId,
        productId: order.line.productId,
        providerUsername: providerUsernameFor(serviceId),
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
    const service = await this.deps.services.findById(scope, serviceIdOrNotFound(id));
    if (service === null || service.customerId !== customerId) {
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
  async customerActionsFor(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<readonly CustomerServiceOperation[]> {
    const available: CustomerServiceOperation[] = [];
    for (const type of CUSTOMER_SERVICE_OPERATIONS) {
      if (!OPERATION_LEGAL_FROM[type].includes(service.state)) continue;
      const operable = await this.deps.panels.operability(scope, service.panelId, type);
      if (operable.ok) available.push(type);
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
    input: { readonly idempotencyKey: string },
  ): Promise<OperationRecord> {
    const service = await this.getForCustomer(scope, customerId, serviceId);
    return this.planRequestedOperation(scope, actor, service, type, input, {
      requestedBy: customerId,
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
      /** One of exactly two codes, so a third caller cannot invent a third answer. */
      readonly stateRefusal?:
        | typeof COMMERCE_ERROR_CODES.ORDER_STATE_INVALID
        | typeof COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED;
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
    return this.deps.uow.run(scope, async (tx) => {
      if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'That tenant has stopped accepting work.',
        );
      }
      const open = await this.deps.operations.findOpen(scope, service.id, type, tx);
      if (open !== null) return open;
      const operation = await this.deps.operations.plan(
        scope,
        {
          id: this.deps.ids.uuid(),
          operationId: this.deps.operationId(`${service.id}:${type}:${input.idempotencyKey}`),
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
    });
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
      readonly kind: 'RENEW' | 'ADD_TRAFFIC' | 'ADD_TIME';
      readonly purchasedTrafficBytes: bigint;
      readonly purchasedDurationDays: number;
    },
    now: Date,
    tx: TransactionScope,
  ): Promise<OperationRecord> {
    const service = await this.deps.services.findById(scope, action.serviceId, tx);
    if (service === null) {
      /*
       * Unreachable: `service_commercial_actions_service_fk` requires the service to
       * exist and the row was written in the transaction that created this order. A
       * refusal rather than a default, because planning against a service that is not
       * there would mean planning against nothing while the customer's money has moved.
       */
      throw new Error(`order ${order.id} names service ${action.serviceId}, which is not there`);
    }

    /*
     * Re-checked at SETTLEMENT, because the window between confirmation and payment is
     * real: a customer can confirm a renewal and pay for it minutes later, and the
     * service can be terminated in between.
     *
     * The refusal is loud rather than silent. Money has already moved in this
     * transaction, so a plan that quietly did nothing would leave a paid order with no
     * operation behind it and nothing to tell an operator why. Throwing rolls the
     * settlement back, which is the same choice `settlementRefusal` makes for the same
     * reason: "money moved but the order did not" must be unrepresentable.
     */
    if (!OPERATION_LEGAL_FROM[action.kind].includes(service.state)) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
        'That service is not in a state this action can be taken from.',
        { state: service.state },
      );
    }

    /*
     * And the PANEL, re-read here for the same window and the same reason.
     *
     * `CommercialActionService` checks operability when the quote is drawn and again
     * when the order is confirmed, and neither is the one that counts: a panel can be
     * disabled, archived, have its credentials rotated or lose the capability between
     * the confirmation and the payment, and this is the transaction the money moves in.
     *
     * Without it the debit commits, the operation is planned, and the provisioner
     * refuses it as `CAPABILITY_UNSUPPORTED` — which is PERMANENT — leaving a paid
     * order that can never be applied and an operator with no way to make it apply. The
     * refusal here rolls the settlement back instead, which is the same choice the
     * lifecycle check above makes: "money moved but the order did not" must be
     * unrepresentable.
     */
    const operable = await this.deps.panels.operability(scope, service.panelId, action.kind, tx);
    if (!operable.ok) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
        'The panel this service lives on cannot perform that action.',
        { reason: operable.reason ?? 'UNKNOWN' },
      );
    }

    /*
     * ONE outstanding commercial action per service, refused by NAME here and by
     * `provisioning_operations_open_commercial_key` underneath.
     *
     * The target below is ABSOLUTE and is computed from the two columns this service
     * row carries RIGHT NOW. A second purchase that settles before the first reaches
     * the panel reads the same two numbers and plans the same target: two five-gigabyte
     * packages against a ten-gigabyte service each plan fifteen, the customer is charged
     * twice, and the account ends where one purchase would have left it.
     *
     * Serialising EXECUTION does not fix it and already happens — `claimDue` refuses to
     * run two operations for one service at once. The rows were wrong before either ran.
     *
     * TRANSIENT, and said so: the customer's next step is to wait a moment, which is
     * why `SERVICE_ACTION_IN_PROGRESS` is its own code rather than folded into the
     * lifecycle refusal above.
     */
    const outstanding = await this.deps.operations.findOpenCommercial(scope, service.id, tx);
    if (outstanding !== null) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
        'This service already has an action waiting to be applied.',
        { operationId: outstanding.operationId },
      );
    }

    /*
     * What the panel should end up holding, from what was bought plus what the service
     * holds now.
     *
     * `null` where the purchase bought nothing of that kind, which is the same meaning
     * the column, the provider plan and the adapter's omitted key all carry — so the
     * three agree without anybody translating between them.
     */
    const target: OperationTarget = {
      expiresAt:
        action.purchasedDurationDays > 0
          ? extendedExpiry(service.expiresAt, now, action.purchasedDurationDays)
          : null,
      trafficLimitBytes:
        action.purchasedTrafficBytes > 0n || action.kind === 'RENEW'
          ? extendedAllowance(service.trafficLimitBytes, action.purchasedTrafficBytes)
          : null,
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

    if (target.expiresAt === null && target.trafficLimitBytes === null) {
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

    const operation = await this.deps.operations.plan(
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
        },
        after: {
          orderId: order.id,
          customerId: order.customerId,
          operationId: operation.operationId,
          targetExpiresAt: target.expiresAt?.toISOString() ?? null,
          targetTrafficLimitBytes: target.trafficLimitBytes?.toString() ?? null,
        },
        result: 'SUCCESS',
      },
      tx,
    );

    return operation;
  }

  /** Whether a service is in a state where re-sending its configuration means anything. */
  static isDeliverable(service: ServiceRecord): boolean {
    const live: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];
    return live.includes(service.state) && service.subscriptionUrl !== null;
  }
}

/** Kept honest: the sentinel the schema stores for an unlimited allowance is zero. */
export const UNLIMITED_TRAFFIC_SENTINEL = UNLIMITED_TRAFFIC_BYTES;
