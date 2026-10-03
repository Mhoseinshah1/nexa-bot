import {
  BULK_TRAFFIC_MAX_BYTES,
  COMMERCE_ERROR_CODES,
  SERVICE_GRANT_DURATION_MAX_DAYS,
  errors,
  parseTrafficGb,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type ServiceGrantRequest,
  type TenantContext,
  type UnitOfWork,
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
import type { ProvisioningService } from './provisioning.service.js';
import type { OperationRecord, OperationRepository, ServiceRepository } from './ports.js';
import { serviceIdOrNotFound } from './service-id.js';

export const SERVICE_GRANT_PERMISSION = 'services.grant' satisfies PermissionKey;

export interface ServiceGrantServiceDeps {
  readonly provisioning: Pick<ProvisioningService, 'planGrant'>;
  readonly services: Pick<ServiceRepository, 'findById'>;
  readonly operations: Pick<OperationRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly clock: Clock;
}

/** The refusals `planGrant` answers with, as the code an operator's screen can name. */
function refusalFor(reason: string): Error {
  switch (reason) {
    case 'UNLIMITED':
      return errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'This service has no limit in that dimension to add to.',
        { reason },
      );
    case 'LIMIT_EXCEEDED':
      return errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_UNAVAILABLE,
        'That much more is past what the panel can hold.',
        { reason },
      );
    case 'ACTION_IN_PROGRESS':
      return errors.conflict(
        COMMERCE_ERROR_CODES.SERVICE_ACTION_IN_PROGRESS,
        'This service already has an action waiting to be applied.',
        { reason },
      );
    default:
      return reason.startsWith('SERVICE_') ||
        reason === 'TERMINATION_PENDING' ||
        reason === 'REFUND_REQUESTED'
        ? errors.conflict(
            COMMERCE_ERROR_CODES.SERVICE_ACTION_NOT_ALLOWED,
            'That service is not in a state this action can be taken from.',
            { reason },
          )
        : errors.conflict(
            COMMERCE_ERROR_CODES.PANEL_NOT_OPERABLE,
            'The panel this service lives on cannot perform that action.',
            { reason },
          );
  }
}

/**
 * Program §13 — an operator's FREE traffic or time grant to ONE service.
 *
 * The same planner a mass grant's item uses (`ProvisioningService.planGrant`), which is
 * the same path a purchased add-on takes: the owner, the legal state, the panel's
 * operability, an open commercial action, a pending deletion or refund request, a limit to
 * add to and the panel's ceiling are all decided there, under the service's lifecycle
 * lock, and the target is computed once and absolutely. No provider is called here; the
 * provisioner executes the operation exactly as it executes a paid one.
 *
 * `services.grant` (HIGH, the owner's): this is free service. The reason is mandatory and
 * is on the audit row beside the operation id. Idempotent twice over: the WEB key answers
 * a replay with the first operation, and the operation id derives from the key, so a
 * retried request plans the same operation rather than a second grant.
 */
export class ServiceGrantService {
  constructor(private readonly deps: ServiceGrantServiceDeps) {}

  async grant(
    scope: TenantContext,
    actor: ActorContext,
    serviceId: string,
    input: ServiceGrantRequest,
  ): Promise<OperationRecord> {
    const denial = { action: 'service.operator_grant', entityType: 'Service', entityId: serviceId };
    await this.authorize(scope, actor, denial);
    const id = serviceIdOrNotFound(serviceId);
    const amount = this.amountOf(input);
    const reason = input.reason.trim();
    const requestHash = hashRequest({
      serviceId: id,
      kind: input.kind,
      trafficBytes: amount.trafficBytes.toString(),
      durationDays: amount.durationDays,
      reason,
    });
    const replay = await this.deps.idempotency.find<{ operationRowId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const operation = await this.deps.operations.findById(scope, replay.result.operationRowId);
      if (operation !== null) return operation;
    }

    const now = this.deps.clock.now();
    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SERVICE_GRANT_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const service = await this.deps.services.findById(scope, id, tx);
        // Another tenant's service is the NOT_FOUND an unknown id gets.
        if (service === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
        }
        const planned = await this.deps.provisioning.planGrant(
          scope,
          actor,
          {
            serviceId: service.id,
            customerId: service.customerId,
            kind: input.kind,
            trafficBytes: amount.trafficBytes,
            durationDays: amount.durationDays,
            // One command, one operation: the key is the command's own.
            grantKey: `operator:${input.idempotencyKey}`,
          },
          now,
          tx,
        );
        if (planned.outcome === 'UNFULFILLABLE') throw refusalFor(planned.reason);
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: 'service.operator_grant',
            entityType: 'Service',
            entityId: service.id,
            before: null,
            after: {
              kind: input.kind,
              trafficBytes: input.kind === 'ADD_TRAFFIC' ? amount.trafficBytes.toString() : null,
              durationDays: input.kind === 'ADD_TIME' ? amount.durationDays : null,
              operationId: planned.operation.operationId,
            },
            result: 'SUCCESS',
            reason,
          },
          tx,
        );
        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { operationRowId: planned.operation.id },
          tx,
        );
        return planned.operation;
      },
    );
  }

  private amountOf(input: ServiceGrantRequest): {
    readonly trafficBytes: bigint;
    readonly durationDays: number;
  } {
    if (input.kind === 'ADD_TIME') {
      if (input.durationDays < 1 || input.durationDays > SERVICE_GRANT_DURATION_MAX_DAYS) {
        throw errors.validation(
          COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
          'That duration cannot be granted.',
        );
      }
      return { trafficBytes: 0n, durationDays: input.durationDays };
    }
    const bytes = parseTrafficGb(input.trafficGb);
    // The mass grant's bound, per service: one ceiling for "free traffic", wherever given.
    if (bytes === null || bytes <= 0n || bytes > BULK_TRAFFIC_MAX_BYTES) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That traffic cannot be granted.',
      );
    }
    return { trafficBytes: bytes, durationDays: 0 };
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

  /** Before the replay lookup: a replay returns an operation, and a guessed key must not. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, SERVICE_GRANT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SERVICE_GRANT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }
}
