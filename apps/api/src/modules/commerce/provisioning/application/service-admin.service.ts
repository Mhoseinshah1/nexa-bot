import {
  COMMERCE_ERROR_CODES,
  errors,
  SERVICE_PAGE_MAX,
  type ActorContext,
  type OperationType,
  type PermissionKey,
  type ServiceActionAvailability,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { SERVICE_PAGE_DEFAULT } from './provisioning.service.js';
import { serviceIdOrNotFound } from './service-id.js';
import {
  evaluateServiceActions,
  SERVICE_ACTION_OPERATION_TYPES,
  type ServiceContactPresence,
} from './service-actions.js';
import type {
  CustomerContactReader,
  OperationRecord,
  OperationRepository,
  PanelOperability,
  PanelOperabilityReader,
  ServiceCursor,
  ServicePage,
  ServiceRecord,
  ServiceRepository,
  ServiceSearch,
} from './ports.js';

/** What an operator needs to read the service list and a service's detail. */
export const SERVICE_VIEW_PERMISSION: PermissionKey = 'services.view';

/**
 * How many operations a service's history returns.
 *
 * Bounded like every other list here. It is deliberately NOT paged: an operator opens
 * this to answer "what has been attempted on this service", and a service with more
 * than fifty operations against it is itself the finding — `retireExhausted` and the
 * reconcile lane both bound how many an ordinary service accumulates.
 */
export const SERVICE_OPERATION_LIMIT = 50;

export interface ServiceAdminQuery {
  readonly limit?: number;
  readonly cursor?: ServiceCursor;
  readonly search: ServiceSearch;
}

export interface ServiceAdminServiceDeps {
  readonly services: ServiceRepository;
  readonly operations: OperationRepository;
  readonly guard: PermissionGuard;
  /**
   * The panel's verdict per operation type, for the action matrix.
   *
   * A READER, and the narrowest one: it answers "can this panel do X" and cannot plan,
   * claim or perform anything. Holding it does not make this a write path — the note
   * below about not holding `ProvisioningService` still stands, and is why the actions
   * are computed here and executed there.
   */
  readonly panels: PanelOperabilityReader;
  /** Whether there is anywhere to resend a configuration to. Read-only. */
  readonly contacts: CustomerContactReader;
}

/**
 * Services, as an operator reads them.
 *
 * `docs/phase4h-audit.md` §7 is the measurement this closes: `services.view`,
 * `services.edit`, `services.terminate` and `services.transfer` have been declared
 * permissions since Phase 2, three seeded roles carry the first two, services have been
 * real rows since 4D — and there was no endpoint and no screen. An operator whose role
 * said they could view services could not view one. It is the same defect class as
 * Codex C5 on PR #29, where `receipt_reviewer` could not open the payment its own name
 * refers to: a permission the product grants and the product cannot exercise.
 *
 * ## Still read-only, and that is now a structural claim rather than a scope note
 *
 * Phase 6A gave the Web Admin seven actions, and NONE of them is here: they are
 * `ProvisioningService`'s, `DeliveryService`'s and the controller's. What this service
 * gained is `detail`, which answers which of them are available and why not — a
 * decision, not an effect.
 *
 * So it still holds no service that can reach a provider. `ProvisioningService` plans
 * work and `DeliveryService` sends; holding either would put a read path one call away
 * from planning a provider operation. The two readers it did gain — panel operability
 * and customer contact — can answer a question and do nothing else.
 *
 * A transfer is still absent, and still for a real reason: there is no stated rule for
 * what becomes of the order, the payment and the subscription the previous owner holds.
 * `docs/open-questions.md` carries it, and inventing the answer inside a controller is
 * the guess this repository refuses.
 */
export class ServiceAdminService {
  constructor(private readonly deps: ServiceAdminServiceDeps) {}

  /** A page of services for an operator. */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: ServiceAdminQuery,
  ): Promise<ServicePage> {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW_PERMISSION);
    const limit = Math.min(Math.max(query.limit ?? SERVICE_PAGE_DEFAULT, 1), SERVICE_PAGE_MAX);
    return this.deps.services.list(scope, query.search, limit, query.cursor ?? null);
  }

  async get(scope: TenantContext, actor: ActorContext, id: string) {
    await this.deps.guard.check(scope, actor, SERVICE_VIEW_PERMISSION);
    const service = await this.deps.services.findById(scope, serviceIdOrNotFound(id));
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
  }

  /**
   * One service AND what may be done to it.
   *
   * Phase 6A. `get` answers with the row; this answers with the row and the seven
   * action verdicts, which is what a screen with buttons needs. The verdicts are
   * computed by `evaluateServiceActions` from facts gathered here — the state, whether
   * a configuration and a contact exist, which operations are already open, and the
   * panel's capability verdict per type — so the surface renders a decision it did not
   * make.
   *
   * ## The gathering is deliberately not one clever query
   *
   * `SERVICE_ACTION_OPERATION_TYPES` is derived from the action table, so a new action
   * cannot leave its panel question unasked. The open-operation lookups and the
   * operability reads are per type and run concurrently; all of them are reads, none is
   * inside a transaction, and none of them authorizes anything — the write paths check
   * every one of these conditions again, under the lock, because between this read and
   * the operator's click an operation can open and a panel can be disabled.
   *
   * ## The contact read is the one that is NOT about the panel
   *
   * A resend needs a customer with a durable bot link who is not blocked, which is
   * `contactFor`'s three-way answer. `BLOCKED` reduces to `ABSENT` here: the block is
   * an instruction not to message that customer, and a resend button that ignored it
   * would be this surface overriding an operator's own decision.
   */
  async detail(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<{ service: ServiceRecord; actions: readonly ServiceActionAvailability[] }> {
    const service = await this.get(scope, actor, id);
    const [openOperations, operability, contact] = await Promise.all([
      this.openOperationsFor(scope, service.id),
      this.operabilityFor(scope, service),
      this.contactPresenceFor(scope, service),
    ]);
    return {
      service,
      actions: evaluateServiceActions({
        state: service.state,
        hasConfiguration: service.subscriptionUrl !== null,
        contact,
        openOperations,
        operability,
      }),
    };
  }

  private async openOperationsFor(
    scope: TenantContext,
    serviceId: string,
  ): Promise<readonly OperationType[]> {
    const found = await Promise.all(
      SERVICE_ACTION_OPERATION_TYPES.map(async (type) =>
        (await this.deps.operations.findOpen(scope, serviceId, type)) === null ? null : type,
      ),
    );
    return found.filter((type): type is OperationType => type !== null);
  }

  private async operabilityFor(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<Readonly<Partial<Record<OperationType, PanelOperability>>>> {
    const verdicts = await Promise.all(
      SERVICE_ACTION_OPERATION_TYPES.map(
        async (type) =>
          [type, await this.deps.panels.operability(scope, service.panelId, type)] as const,
      ),
    );
    return Object.fromEntries(verdicts) as Readonly<
      Partial<Record<OperationType, PanelOperability>>
    >;
  }

  private async contactPresenceFor(
    scope: TenantContext,
    service: ServiceRecord,
  ): Promise<ServiceContactPresence> {
    const lookup = await this.deps.contacts.contactFor(scope, service.customerId);
    return lookup.kind === 'CONTACT' ? 'PRESENT' : 'ABSENT';
  }

  /**
   * What has been attempted on one service, newest first, bounded.
   *
   * The service is READ FIRST, through `get`, and that ordering is the tenancy check
   * rather than a convenience: `listForService` takes a service id and a scope, and a
   * caller that passed an id belonging to another tenant would get an empty list —
   * which reads as "nothing has been attempted" rather than as "this is not yours".
   * Going through `get` means the answer is `SERVICE_NOT_FOUND`, the same answer an id
   * that does not exist gets.
   */
  async operations(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<readonly OperationRecord[]> {
    const service = await this.get(scope, actor, id);
    /*
     * `listRecentForService`, not `listForService`.
     *
     * The bound and the ORDER have to agree: `listForService` is ascending because a
     * caller counts provisioning cycles in its first fifty, so asking it for fifty here
     * returned the OLDEST fifty behind a docblock promising the newest — exactly when
     * the history is long enough for the difference to matter, and with the most recent
     * failures, the ones an operator came to read, missing. Found by the Codex review
     * of PR #30.
     */
    return this.deps.operations.listRecentForService(scope, service.id, SERVICE_OPERATION_LIMIT);
  }

  /**
   * Validated, not cast.
   *
   * The id reaches a `uuid` column. A malformed one is `SERVICE_NOT_FOUND` rather than
   * a 500 at the cast or a refusal that names the column — the shape every other
   * surface here uses.
   */
}
