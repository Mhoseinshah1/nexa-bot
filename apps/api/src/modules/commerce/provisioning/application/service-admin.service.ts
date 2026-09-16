import {
  COMMERCE_ERROR_CODES,
  errors,
  SERVICE_PAGE_MAX,
  uuidV7Schema,
  type ActorContext,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { SERVICE_PAGE_DEFAULT } from './provisioning.service.js';
import type {
  OperationRecord,
  OperationRepository,
  ServiceCursor,
  ServicePage,
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
 * ## Read-only, and the omission is deliberate
 *
 * There is no terminate and no transfer here, although both are declared permissions.
 * Terminating from the Web Admin needs the operator-initiated half of a flow whose
 * customer half is 4E's and whose outcome announcement is 4H's, and it is a HIGH-risk
 * permission that deletes somebody's provider account. A transfer has no stated rule at
 * all for what becomes of the order, the payment and the subscription the previous owner
 * still holds; `docs/open-questions.md` carries it, and inventing the answer inside a
 * controller is the guess this repository refuses.
 *
 * Shipping the read is not a partial feature. It is the whole of what `services.view`
 * already promised and could not do.
 *
 * ## It holds the repositories, not the other services
 *
 * `ProvisioningService` plans work and `DeliveryService` sends; neither is wanted here,
 * and holding either would put a read path one call away from planning a provider
 * operation. Two repositories, both read-only on this path.
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
    const service = await this.deps.services.findById(scope, this.serviceId(id));
    if (service === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return service;
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
  private serviceId(raw: string): string {
    const parsed = uuidV7Schema.safeParse(raw);
    if (!parsed.success) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
    }
    return parsed.data;
  }
}
