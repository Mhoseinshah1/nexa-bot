import {
  COMMERCE_ERROR_CODES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * `botctl customers prune-empty` — remove the customer rows that nothing refers to.
 *
 * Why it exists: before the group-join fix, a user joining a GROUP created a customer row
 * (`resolveFromUpdate`). Those rows own nothing, and they make the Mirza import's
 * fresh-target check (zero customers) fail.
 *
 * Deleting a customer is not otherwise possible in this system ("there is no delete path",
 * schema.ts), so the rule is narrow and every part of it is a test:
 *
 *   - a customer is pruned only if NO row anywhere refers to it: every foreign key into
 *     `customers`, every `*customer_id` column whether or not it has a foreign key, and the
 *     two other references the repository names;
 *   - only a customer the bot registered (`source = 'NEXA'`), not blocked, with no phone and
 *     no personal discount;
 *   - the check is made again inside the deleting transaction, on rows locked FOR UPDATE;
 *   - never more than the operator confirmed.
 *
 * What stays behind is history, and that is deliberate: the `customer.registered` audit row
 * (append-only, no foreign key), the `CustomerRegistered` outbox event (its consumer skips a
 * customer that no longer exists). The update's idempotency row is deleted with the customer,
 * because left behind a redelivery of that update would collide with its own old key.
 *
 * Permission `maintenance.run`, held by `systemJobActor`. Audit: who, the count and the ids.
 */
export const CUSTOMER_PRUNE_PERMISSION: PermissionKey = 'maintenance.run';
export const CUSTOMER_PRUNE_AUDIT_ACTION = 'customers.prune_empty';

export interface PruneCandidate {
  readonly id: string;
  readonly telegramUserId: string;
  readonly displayName: string;
  readonly createdAt: Date;
}

export interface PruneListing {
  readonly candidates: readonly PruneCandidate[];
  /** Customers with no dependents that stay anyway: blocked, imported, a phone or a discount. */
  readonly keptForStanding: number;
  /** How many distinct tables were checked for a reference to a customer. */
  readonly dependentTables: number;
}

export interface CustomerPruneRepository {
  /** Read-only; takes no lock. */
  list(scope: TenantContext): Promise<PruneListing>;
  /**
   * Inside the transaction: locks the apparently-empty customers FOR UPDATE, then checks
   * again with a fresh statement and returns the ones that are still empty.
   */
  lockAndRecheck(scope: TenantContext, tx: unknown): Promise<readonly PruneCandidate[]>;
  deleteByIds(scope: TenantContext, ids: readonly string[], tx: unknown): Promise<number>;
}

export interface CustomerPruneDeps {
  readonly repository: CustomerPruneRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
  /** Read inside the deleting transaction: a stopped installation deletes nothing. */
  readonly scopeActivity: ScopeActivityReader;
}

export class CustomerPruneService {
  constructor(private readonly deps: CustomerPruneDeps) {}

  /** The dry run, and the default: lists, changes nothing. */
  async list(scope: TenantContext, actor: ActorContext): Promise<PruneListing> {
    await this.deps.guard.check(scope, actor, CUSTOMER_PRUNE_PERMISSION);
    return this.deps.repository.list(scope);
  }

  /**
   * Deletes, in ONE transaction, the customers that are STILL empty, at most
   * `expectedCount` of them (the number the operator was shown and confirmed). More than
   * that means somebody joined since, and nothing is deleted: run the listing again.
   * Fewer is fine — a customer that gained a dependent is simply not deleted.
   */
  async apply(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly expectedCount: number },
  ): Promise<{ readonly deleted: number }> {
    if (!Number.isInteger(input.expectedCount) || input.expectedCount < 0) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'The confirmed count is not a number.',
      );
    }
    await this.deps.guard.check(scope, actor, CUSTOMER_PRUNE_PERMISSION);
    return runAuthorizedMutation(
      {
        uow: this.deps.uow,
        guard: this.deps.guard,
        audit: this.deps.audit,
        opsLog: this.deps.opsLog,
        sessions: this.deps.sessions,
        clock: this.deps.clock,
      },
      scope,
      actor,
      CUSTOMER_PRUNE_PERMISSION,
      { action: CUSTOMER_PRUNE_AUDIT_ACTION, entityType: 'Customer', entityId: null },
      async (tx) => {
        // Inside the transaction, as every write path: a stop can commit after the CLI began.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const empty = await this.deps.repository.lockAndRecheck(scope, tx);
        if (empty.length > input.expectedCount) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'More customers are empty now than were confirmed.',
          );
        }
        if (empty.length === 0) return { deleted: 0 };
        const deleted = await this.deps.repository.deleteByIds(
          scope,
          empty.map((c) => c.id),
          tx,
        );
        if (deleted !== empty.length) {
          // Locked rows that did not delete: roll the whole thing back rather than report it.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'The rows deleted differ from the rows locked.',
          );
        }
        await this.deps.audit.record(
          scope,
          actor,
          {
            action: CUSTOMER_PRUNE_AUDIT_ACTION,
            entityType: 'Customer',
            entityId: null,
            before: { confirmed: input.expectedCount },
            after: { deleted, customerIds: empty.map((c) => c.id) },
            result: 'SUCCESS',
          },
          tx,
        );
        return { deleted };
      },
    );
  }
}
