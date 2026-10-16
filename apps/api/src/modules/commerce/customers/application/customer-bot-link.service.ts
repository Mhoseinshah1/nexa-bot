import {
  errors,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';

/**
 * OI-1, part 2 — link IMPORTED customers to the production bot at cutover.
 *
 * The legacy importer creates customers with `first_bot_instance_id = NULL`, and every
 * customer notification drops a NULL. This service fills it, for customers that
 *   (a) have a NULL link, AND
 *   (b) have a `legacy_import_map` row (`entity_type = 'CUSTOMER'`, `status = 'IMPORTED'`)
 *       pointing at them — i.e. the importer created them.
 * It never overwrites a link and never touches a customer the importer did not create.
 *
 * It turns reminders and notices ON for every customer it links, so it runs only on the
 * owner's go-live decision (see the CLI's two-key refusal). Permission: `maintenance.run`,
 * held by `systemJobActor`. Audit: counts and the bot id only, never a customer.
 */
export const CUSTOMER_BOT_LINK_PERMISSION: PermissionKey = 'maintenance.run';
export const CUSTOMER_BOT_LINK_AUDIT_ACTION = 'customers.link_imported_to_bot';
export const CUSTOMER_BOT_LINK_BATCH_DEFAULT = 500;
export const CUSTOMER_BOT_LINK_BATCH_MAX = 5_000;

export interface CustomerBotLinkRepository {
  /** Whether the bot instance exists in this tenant. */
  botExists(scope: TenantContext, botInstanceId: BotInstanceId, tx?: unknown): Promise<boolean>;
  /** Imported customers with a NULL link. */
  countEligible(scope: TenantContext, tx?: unknown): Promise<number>;
  /**
   * Links up to `limit` eligible customers to the bot (`WHERE first_bot_instance_id IS NULL`
   * in the UPDATE itself, so a concurrent writer's value is never replaced) and returns how
   * many it linked.
   */
  linkBatch(
    scope: TenantContext,
    input: { botInstanceId: BotInstanceId; limit: number; now: Date },
    tx?: unknown,
  ): Promise<number>;
}

export interface CustomerBotLinkDeps {
  readonly repository: CustomerBotLinkRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly clock: Clock;
}

export interface CustomerBotLinkReport {
  readonly mode: 'DRY_RUN' | 'APPLY';
  readonly botInstanceId: BotInstanceId;
  /** Eligible before the run. */
  readonly eligible: number;
  /** Linked by this run (0 on a dry run, and on a re-run). */
  readonly linked: number;
  readonly batches: number;
}

export class CustomerBotLinkService {
  constructor(private readonly deps: CustomerBotLinkDeps) {}

  async dryRun(
    scope: TenantContext,
    actor: ActorContext,
    botInstanceId: BotInstanceId,
  ): Promise<CustomerBotLinkReport> {
    await this.deps.guard.check(scope, actor, CUSTOMER_BOT_LINK_PERMISSION);
    await this.requireBot(scope, botInstanceId);
    const eligible = await this.deps.repository.countEligible(scope);
    return { mode: 'DRY_RUN', botInstanceId, eligible, linked: 0, batches: 0 };
  }

  /**
   * One transaction, one audit row per batch. Idempotent: a batch only matches rows still
   * NULL, so a re-run (or a run resumed after a crash) links nothing twice.
   */
  async apply(
    scope: TenantContext,
    actor: ActorContext,
    botInstanceId: BotInstanceId,
    batchSize: number = CUSTOMER_BOT_LINK_BATCH_DEFAULT,
  ): Promise<CustomerBotLinkReport> {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > CUSTOMER_BOT_LINK_BATCH_MAX) {
      throw errors.validation('customers.bot_link_invalid', 'The batch size is out of range.');
    }
    await this.deps.guard.check(scope, actor, CUSTOMER_BOT_LINK_PERMISSION);
    await this.requireBot(scope, botInstanceId);
    const eligible = await this.deps.repository.countEligible(scope);
    let linked = 0;
    let batches = 0;
    for (;;) {
      const n = await runAuthorizedMutation(
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
        CUSTOMER_BOT_LINK_PERMISSION,
        { action: CUSTOMER_BOT_LINK_AUDIT_ACTION, entityType: 'Bot', entityId: botInstanceId },
        async (tx) => {
          const count = await this.deps.repository.linkBatch(
            scope,
            { botInstanceId, limit: batchSize, now: this.deps.clock.now() },
            tx,
          );
          if (count > 0) {
            // Counts and the bot id only: no customer id, no Telegram id.
            await this.deps.audit.record(
              scope,
              actor,
              {
                action: CUSTOMER_BOT_LINK_AUDIT_ACTION,
                entityType: 'Bot',
                entityId: botInstanceId,
                before: null,
                after: { linked: count },
                result: 'SUCCESS',
              },
              tx,
            );
          }
          return count;
        },
      );
      if (n === 0) break;
      linked += n;
      batches += 1;
    }
    return { mode: 'APPLY', botInstanceId, eligible, linked, batches };
  }

  private async requireBot(scope: TenantContext, botInstanceId: BotInstanceId): Promise<void> {
    if (!(await this.deps.repository.botExists(scope, botInstanceId))) {
      throw errors.notFound('customers.bot_link_invalid', 'No such bot in this tenant.');
    }
  }
}
