import {
  COMMERCE_ERROR_CODES,
  SERVICE_PAGE_MAX,
  errors,
  isNexaError,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type CustomerServicesToggleAction,
  type IdempotencyStore,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import { OPERATOR_OPERATION_PERMISSION, type ProvisioningService } from './provisioning.service.js';
import type { ServiceCursor, ServiceRecord, ServiceRepository } from './ports.js';

/** The most services one command walks. Past it the operator is told to run it again. */
export const CUSTOMER_SERVICES_TOGGLE_MAX = 200;

export interface CustomerServicesToggleDeps {
  readonly services: Pick<ServiceRepository, 'list'>;
  readonly provisioning: Pick<ProvisioningService, 'requestFromOperator'>;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
}

export interface CustomerServicesToggleResult {
  readonly serviceId: string;
  readonly providerUsername: string;
  readonly outcome: 'PLANNED' | 'REFUSED';
  readonly code: string | null;
}

/**
 * Customer 360 (§11.4): disable or enable every configuration a customer has — SUSPEND each
 * ACTIVE service, or RESUME each SUSPENDED one.
 *
 * Not a second suspend: each service goes through `ProvisioningService.requestFromOperator`,
 * the very call the service page's own button makes, so each is charged `services.edit`,
 * re-decided against its panel's capabilities and its open operations, audited, and planned
 * for the provisioner — the panel is never dialled from a request. One service refusing
 * (a panel that cannot suspend, an operation already open) does not stop the others; its
 * code is reported beside it.
 *
 * Resumable: each service's key is derived from the operator's key and the service id, so
 * a retry after a timeout replays what was planned and plans only what was not.
 */
export class CustomerServicesToggleService {
  constructor(private readonly deps: CustomerServicesToggleDeps) {}

  async toggle(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
      readonly action: CustomerServicesToggleAction;
    },
  ): Promise<readonly CustomerServicesToggleResult[]> {
    const parsed = userIdSchema.safeParse(input.customerId);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    const customerId = parsed.data;
    const permission: PermissionKey = OPERATOR_OPERATION_PERMISSION[input.action];
    await this.deps.guard.check(scope, actor, 'users.view');
    await this.deps.guard.check(scope, actor, permission);

    const from = input.action === 'SUSPEND' ? 'ACTIVE' : 'SUSPENDED';
    const targets: ServiceRecord[] = [];
    let cursor: ServiceCursor | null = null;
    do {
      const page = await this.deps.services.list(
        scope,
        { customerId, state: from },
        SERVICE_PAGE_MAX,
        cursor,
      );
      targets.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== null && targets.length < CUSTOMER_SERVICES_TOGGLE_MAX);

    const stem = `toggle:${hashRequest({ key: input.idempotencyKey, action: input.action }).slice(0, 40)}`;
    const results: CustomerServicesToggleResult[] = [];
    for (const service of targets.slice(0, CUSTOMER_SERVICES_TOGGLE_MAX)) {
      try {
        await this.deps.provisioning.requestFromOperator(scope, actor, service.id, input.action, {
          idempotencyKey: `${stem}:${service.id}`,
        });
        results.push({
          serviceId: service.id,
          providerUsername: service.providerUsername,
          outcome: 'PLANNED',
          code: null,
        });
      } catch (error) {
        // A decided refusal for THIS service. Anything else is not ours to swallow — but the
        // customer's timeline still says the command ran, and how far, before it stopped.
        if (!isNexaError(error) || error.httpStatus >= 500) {
          await this.summarise(scope, actor, customerId, input.action, results, stem, 'FAILED');
          throw error;
        }
        results.push({
          serviceId: service.id,
          providerUsername: service.providerUsername,
          outcome: 'REFUSED',
          code: error.code,
        });
      }
    }

    // One row on the customer's own timeline; each service's own row is the operation's.
    await this.summarise(scope, actor, customerId, input.action, results, stem, 'SUCCESS');
    return results;
  }

  /**
   * The summary row, once per command: a SUCCESS remembers the command's key in the same
   * transaction, so a replay — which re-plans nothing, every service's own key answering
   * for it — finds the key and writes no second row. A FAILED one is not remembered: the
   * retry that completes the command is entitled to its own SUCCESS row.
   */
  private async summarise(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    action: CustomerServicesToggleAction,
    results: readonly CustomerServicesToggleResult[],
    stem: string,
    result: 'SUCCESS' | 'FAILED',
  ): Promise<void> {
    const key = `${stem}:summary`;
    const hash = hashRequest({ customerId, action });
    try {
      await this.deps.uow.run(scope, async (tx) => {
        if (
          result === 'SUCCESS' &&
          (await this.deps.idempotency.find(scope, actor.surface, key, hash)) !== null
        ) {
          return;
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action:
              action === 'SUSPEND'
                ? 'customer.services.suspend_all'
                : 'customer.services.resume_all',
            entityType: 'Customer',
            entityId: customerId,
            before: null,
            after: {
              planned: results.filter((entry) => entry.outcome === 'PLANNED').length,
              refused: results.filter((entry) => entry.outcome === 'REFUSED').length,
            },
            result,
          },
          tx,
        );
        if (result === 'SUCCESS') {
          await rememberOnce(this.deps.idempotency, scope, actor.surface, key, hash, {}, tx);
        }
      });
    } catch (error) {
      // The FAILED row is a courtesy beside the error being rethrown; never a second error.
      if (result === 'SUCCESS') throw error;
    }
  }
}
