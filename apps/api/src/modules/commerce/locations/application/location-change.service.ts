import {
  COMMERCE_ERROR_CODES,
  errors,
  serviceIdSchema,
  serviceLocationIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ServiceLocationId,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { ServiceRepository } from '../../provisioning/application/ports.js';
import type { ProvisioningService } from '../../provisioning/application/provisioning.service.js';
import type { ResellerService } from '../../resellers/application/reseller.service.js';
import { OPERATION_LEGAL_FROM } from '../../provisioning/application/provision-executor.js';
import type { LocationChangePolicy } from './location-change-policy.js';
import type { LocationChangeRepository } from './ports.js';

/**
 * What a customer's free location change acts under: `maintenance.run`, exactly as every
 * other customer command through the webhook's `SYSTEM_JOB` — a customer holds no
 * permissions of their own, and the check is still MADE.
 */
export const LOCATION_CHANGE_PERMISSION: PermissionKey = 'maintenance.run';

/** The customer namespace, shared with ordering and commercial actions. */
const CUSTOMER_NAMESPACE = 'TELEGRAM' as const;

export interface LocationChangeServiceDeps {
  readonly services: Pick<ServiceRepository, 'findById' | 'lockLifecycle'>;
  readonly policy: Pick<LocationChangePolicy, 'decide'>;
  readonly changes: Pick<LocationChangeRepository, 'create'>;
  readonly provisioning: Pick<ProvisioningService, 'planLocationChange'>;
  /**
   * A reseller's standing and entitlements (`docs/wp9-reseller-audit.md` R5, R6): a free
   * move is still an operation a reseller's tier must grant, decided exactly as the paid
   * quote decides it — deny by default for an ACTIVE reseller without the grant.
   */
  readonly resellers: Pick<ResellerService, 'standing' | 'assertEntitled'>;
  /** Whether THIS service's panel can move an account — the executor's own question. */
  readonly panels: {
    operability(
      scope: TenantContext,
      panelId: string,
      type: 'CHANGE_LOCATION',
      tx?: unknown,
    ): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  };
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * A customer's FREE location change (WP-A6): asked for, not bought.
 *
 * A move the operator priced at zero writes no order and no payment — there is nothing to
 * settle and nothing a failure could refund — so it is not a commercial ORDER, and
 * `CommercialActionService` refuses to quote one. Everything else is the paid move's:
 * the same `LocationChangePolicy` decision (not where it already is, within the cooldown
 * and the rolling limit), the same `prepareCommercialAction` refusals (owner, state,
 * panel capability, another commercial action open, a deletion or refund request
 * pending), the same one-open-commercial-action index, the same `CHANGE_LOCATION`
 * operation to an absolute key, the same provisioner, verification and announcement.
 *
 * One transaction: the lifecycle lock, the decision, the operation, the frozen change
 * request, the audit row and the idempotency record. A replayed tap returns the first
 * result; a key reused with a different target is refused as a different command.
 */
export class LocationChangeService {
  constructor(private readonly deps: LocationChangeServiceDeps) {}

  async requestFree(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
    input: {
      readonly serviceId: string;
      readonly locationId: string;
      readonly idempotencyKey: string;
    },
  ): Promise<{ readonly changeId: string; readonly operationId: string }> {
    const serviceId = this.serviceId(input.serviceId);
    const locationId = this.locationId(input.locationId);
    const requestHash = hashRequest({ customerId, serviceId, locationId, free: true });
    const denial = {
      action: 'service.change_location_request',
      entityType: 'Service',
      entityId: serviceId,
    };
    await this.authorize(scope, actor, denial);
    const replay = await this.deps.idempotency.find<{ changeId: string; operationId: string }>(
      scope,
      CUSTOMER_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) return replay.result;

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      LOCATION_CHANGE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        // The lifecycle lock FIRST, so two requests for one service — or this and a paid
        // move's confirmation — count each other in the cooldown and the limit.
        await this.deps.services.lockLifecycle(scope, serviceId, tx);
        const service = await this.deps.services.findById(scope, serviceId, tx);
        // Another customer's service is the NOT_FOUND an unknown id gets.
        if (service === null || service.customerId !== customerId) {
          throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
        }
        // A custom service (Package D) is moved by nothing in this release, as the quote says.
        const productId = service.productId;
        if (productId === null) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.CUSTOM_SERVICE_NOT_EXTENDABLE,
            'A custom service cannot be renewed or extended.',
          );
        }
        if (!OPERATION_LEGAL_FROM.CHANGE_LOCATION.includes(service.state)) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
            'That service is not in a state this action can be taken from.',
            { state: service.state },
          );
        }
        // The panel first, as a quote asks it: nothing is decided for a panel that cannot.
        const operable = await this.deps.panels.operability(
          scope,
          service.panelId,
          'CHANGE_LOCATION',
          tx,
        );
        if (!operable.ok) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
            'The panel this service lives on cannot perform that action.',
            { reason: operable.reason ?? 'UNKNOWN' },
          );
        }
        const { current, target } = await this.deps.policy.decide(
          scope,
          service,
          locationId,
          now,
          null,
          tx,
        );
        if (target.price.amountMinor !== 0n) {
          // A priced target is BOUGHT, through the quote and the payment it produces.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
            'That location change is not free.',
          );
        }

        // Inside the transaction, from the grants in force now — as `draft` asks it.
        const standing = await this.deps.resellers.standing(scope, customerId, tx);
        if (standing !== null) {
          await this.deps.resellers.assertEntitled(
            scope,
            standing,
            {
              operation: 'CHANGE_LOCATION',
              productId,
              panelId: service.panelId,
            },
            tx,
          );
        }

        const changeId = this.deps.ids.uuid();
        const operation = await this.deps.provisioning.planLocationChange(
          scope,
          actor,
          {
            serviceId,
            customerId,
            locationKey: target.locationKey,
            changeId,
          },
          now,
          tx,
        );
        await this.deps.changes.create(
          scope,
          {
            id: changeId,
            serviceId,
            customerId,
            locationId: target.id,
            locationVersion: target.version,
            fromLocationKey: current.key,
            fromLocationLabel: current.label,
            toLocationKey: target.locationKey,
            toLocationLabel: target.label,
            price: target.price,
            limits: target.limits,
            orderId: null,
            operationId: operation.id,
            now,
          },
          tx,
        );
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: denial.action,
            entityType: 'Service',
            entityId: serviceId,
            before: { locationKey: current.key, locationLabel: current.label },
            after: {
              requestedBy: customerId,
              changeId,
              locationId: target.id,
              locationVersion: target.version,
              toLocationKey: target.locationKey,
              toLocationLabel: target.label,
              priceMinor: '0',
              currency: target.price.currency,
              operationId: operation.operationId,
            },
            result: 'SUCCESS',
          },
          tx,
        );
        const result = { changeId, operationId: operation.id };
        await rememberOnce(
          this.deps.idempotency,
          scope,
          CUSTOMER_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          result,
          tx,
        );
        return result;
      },
    );
  }

  private mutationDeps() {
    return {
      uow: this.deps.uow,
      guard: this.deps.guard,
      audit: this.deps.audit,
      opsLog: this.deps.opsLog,
      sessions: this.deps.sessions,
      clock: this.deps.clock,
    };
  }

  /** Before the replay lookup: a replay returns a result and would hand it to anybody. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, LOCATION_CHANGE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        LOCATION_CHANGE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private serviceId(candidate: string): string {
    const parsed = serviceIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid service identifier.',
      );
    }
    return parsed.data;
  }

  private locationId(candidate: string): ServiceLocationId {
    const parsed = serviceLocationIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid location identifier.',
      );
    }
    return parsed.data;
  }
}
