import {
  COMMERCE_ERROR_CODES,
  errors,
  providerUsernameFor,
  UNLIMITED_TRAFFIC_BYTES,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type OperationId,
  type ServiceState,
  type TenantContext,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { OrderRecord } from '../../orders/application/ports.js';
import type {
  OperationRecord,
  ServiceCursor,
  ServicePage,
  ServiceRecord,
  ServiceRepository,
  ServiceSearch,
  OperationRepository,
} from './ports.js';

/** Reading a service is `services.view`. Reading somebody's config is not a list right. */
const SERVICE_VIEW_PERMISSION = 'services.view';

export const SERVICE_PAGE_DEFAULT = 25;
export const SERVICE_PAGE_MAX = 100;

export interface ProvisioningServiceDeps {
  readonly services: ServiceRepository;
  readonly operations: OperationRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Derives an operation id from a retry-stable key. Bound in the container. */
  readonly operationId: (idempotencyKey: string) => OperationId;
}

export interface ServiceListQuery {
  readonly search: ServiceSearch;
  readonly limit?: number;
  readonly cursor?: ServiceCursor | null;
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

  /** A page of services for an operator. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: ServiceListQuery,
  ): Promise<ServicePage> {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? SERVICE_PAGE_DEFAULT, 1), SERVICE_PAGE_MAX);
    return this.deps.services.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<ServiceRecord> {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW_PERMISSION);
    const service = await this.deps.services.findById(scope, id);
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  /** The operations behind one service, for an operator's detail view. */
  async operationsFor(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    limit = 20,
  ): Promise<readonly OperationRecord[]> {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW_PERMISSION);
    return this.deps.operations.listForService(scope, serviceId, limit);
  }

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
    const service = await this.deps.services.findById(scope, id);
    if (service === null || service.customerId !== customerId) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  /** Whether a service is in a state where re-sending its configuration means anything. */
  static isDeliverable(service: ServiceRecord): boolean {
    const live: readonly ServiceState[] = ['ACTIVE', 'SUSPENDED', 'EXPIRED'];
    return live.includes(service.state) && service.subscriptionUrl !== null;
  }
}

/** Kept honest: the sentinel the schema stores for an unlimited allowance is zero. */
export const UNLIMITED_TRAFFIC_SENTINEL = UNLIMITED_TRAFFIC_BYTES;
