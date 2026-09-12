import { createHash } from 'node:crypto';
import {
  COMMERCE_ERROR_CODES,
  errors,
  profileFactsFrom,
  telegramUserIdSchema,
  type ActorContext,
  type AuditWriter,
  type BotInstanceId,
  type Clock,
  type CustomerArrival,
  type CustomerStatus,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { EventPublisher } from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type {
  CustomerCursor,
  CustomerPage,
  CustomerRecord,
  CustomerRepository,
  CustomerSearch,
} from './ports.js';

/**
 * The permission an inbound Telegram update acts under.
 *
 * `maintenance.run`, the same key `RecordPingService` uses, because this is the same
 * kind of work: system work triggered by a customer. SYSTEM_JOB holds exactly that one
 * key and nothing else, so this is not a bypass — and the check is made for SYSTEM_JOB
 * like every other actor type, because `nexa-conventions` forbids an actor-type
 * exemption.
 */
export const RESOLVE_CUSTOMER_PERMISSION: PermissionKey = 'maintenance.run';

/** Operator-facing reads and writes use the keys that already exist. */
export const CUSTOMER_VIEW_PERMISSION: PermissionKey = 'users.view';
export const CUSTOMER_SEARCH_PERMISSION: PermissionKey = 'users.search';
export const CUSTOMER_BLOCK_PERMISSION: PermissionKey = 'users.block';

export const CUSTOMER_PAGE_DEFAULT = 25;
export const CUSTOMER_PAGE_MAX = 100;
export const BLOCK_REASON_MAX_LENGTH = 500;

export interface CustomerServiceDeps {
  readonly repository: CustomerRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  readonly events: EventPublisher;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * Customers.
 *
 * Two kinds of caller, and they are deliberately separated:
 *
 * - `resolveFromUpdate` runs on the webhook path, acts as SYSTEM_JOB, and is the only
 *   method that creates a customer. It is total in the sense that matters there: a
 *   profile field of an unexpected shape becomes null rather than an exception, because
 *   the alternative is an update Telegram redelivers for ever.
 * - `block`, `unblock`, `get` and `list` are operator commands under the `users.*`
 *   permissions, and they never create anything.
 *
 * A block is NOT reset by arrival. `resolveFromUpdate` refreshes metadata and
 * `last_seen_at` and never touches `status`; the repository's DO UPDATE list proves it
 * by omission, and `blocked survives /start` is a named test. The legacy system's
 * "re-adding an admin returns success and writes nothing" is this defect's mirror
 * image, and both come from a write path that silently decides a state it was not
 * asked about.
 */
export class CustomerService {
  constructor(private readonly deps: CustomerServiceDeps) {}

  /**
   * Resolve the customer behind an inbound update, creating them on first contact.
   *
   * The seven steps, in order, exactly as `nexa-conventions` fixes them. Two details
   * are specific to this path and both are load-bearing:
   *
   * `idempotencyKey` is the caller's — `telegram:<botInstanceId>:update:<updateId>` —
   * so a redelivered update is a replay and returns the first result rather than
   * bumping `last_seen_at` a second time. It is namespaced `TELEGRAM`, which is what
   * stops a Web Admin key consuming it.
   *
   * The upsert is ONE statement, so two concurrent first contacts do not race a
   * read-then-write. The loser takes the DO UPDATE branch and reports
   * `created: false`, which is the honest answer and not an error.
   */
  async resolveFromUpdate(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly telegramUserId: string;
      /** Telegram's raw `from`. Normalised here; never stored as given. */
      readonly from: unknown;
      readonly botInstanceId: BotInstanceId;
    },
  ): Promise<{ readonly customer: CustomerRecord; readonly arrival: CustomerArrival }> {
    // 4. Validate at the boundary. A `from` of the wrong shape yields nulls; a
    //    telegram id of the wrong shape is refused, because it is IDENTITY and a
    //    normalised guess at an identity is a wrong row.
    const telegramUserId = telegramUserIdSchema.parse(input.telegramUserId);
    const profile = profileFactsFrom(input.from);
    const requestHash = hashRequest({ telegramUserId, profile, bot: input.botInstanceId });

    // 5. Idempotency: a replay returns the first result.
    const replay = await this.deps.idempotency.find<{
      customerId: string;
      arrival: CustomerArrival;
    }>(scope, 'TELEGRAM', input.idempotencyKey, requestHash);
    if (replay !== null) {
      const existing = await this.deps.repository.findById(
        scope,
        replay.result.customerId as UserId,
      );
      if (existing !== null) return { customer: existing, arrival: replay.result.arrival };
      // The idempotency row survived its customer, which a restore can produce. Fall
      // through and resolve again rather than fail: the command is idempotent by
      // construction, so redoing it is safe and reporting a missing customer is not.
    }

    const now = this.deps.clock.now();
    const newId = this.deps.ids.uuid() as UserId;

    const outcome = await runAuthorizedMutation(
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
      RESOLVE_CUSTOMER_PERMISSION,
      { action: 'customer.resolve', entityType: 'Customer', entityId: null },
      async (tx) => {
        // Every write path reads scope activity INSIDE its transaction. A surface
        // checked the bot and the tenant on arrival; a stop can commit in between, and
        // `CLAUDE.md` records panels as the one module that skipped this.
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }

        const { customer, created } = await this.deps.repository.resolve(
          scope,
          {
            id: newId,
            telegramUserId,
            profile,
            botInstanceId: input.botInstanceId,
            now,
          },
          tx,
        );

        /*
         * BLOCKED outranks both other arrivals.
         *
         * A blocked customer who sends `/start` is not "returning": the surface must
         * not greet them, and deciding that here rather than in the surface means every
         * surface added later inherits it. The row's metadata was still refreshed,
         * which is deliberate — an operator looking at a blocked account wants to know
         * the name it is using now.
         */
        const arrival: CustomerArrival =
          customer.status === 'BLOCKED' ? 'BLOCKED' : created ? 'FIRST_SEEN' : 'RETURNING';

        if (created) {
          await this.deps.audit.record(
            scope,
            actor,
            {
              action: 'customer.registered',
              entityType: 'Customer',
              entityId: customer.id,
              before: null,
              // The Telegram id is identity and belongs in the audit row. The name and
              // username are NOT: they are third-party text, they change, and an audit
              // row is one of the durable places `redaction.ts` exists to keep clean.
              after: { telegramUserId: customer.telegramUserId },
              result: 'SUCCESS',
            },
            tx,
          );
          await this.deps.events.publish({
            eventType: 'CustomerRegistered',
            aggregateType: 'Customer',
            aggregateId: customer.id,
            payload: {
              telegramUserId: customer.telegramUserId,
              botInstanceId: input.botInstanceId,
            },
          });
        }

        await rememberOnce(
          this.deps.idempotency,
          scope,
          'TELEGRAM',
          input.idempotencyKey,
          requestHash,
          { customerId: customer.id, arrival },
          tx,
        );

        return { customer, arrival };
      },
    );

    return outcome;
  }

  /** One customer, for an operator. Never creates. */
  async get(scope: TenantContext, actor: ActorContext, id: UserId): Promise<CustomerRecord> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    const found = await this.deps.repository.findById(scope, id);
    if (found === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    return found;
  }

  /**
   * A page of customers.
   *
   * Searching requires `users.search` ON TOP of `users.view`, because a list is a view
   * of a tenant's own customers while a search by Telegram id is a lookup of a specific
   * person — a different question, which the permission catalogue already separates.
   */
  async list(
    scope: TenantContext,
    actor: ActorContext,
    query: {
      readonly search?: CustomerSearch;
      readonly limit?: number;
      readonly cursor?: CustomerCursor | null;
    },
  ): Promise<CustomerPage> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    const search = query.search ?? {};
    const searching =
      search.telegramUserId !== undefined ||
      (search.usernamePrefix !== undefined && search.usernamePrefix !== '');
    if (searching) {
      await this.deps.guard.check(scope, actor, CUSTOMER_SEARCH_PERMISSION);
    }
    const limit = Math.min(Math.max(query.limit ?? CUSTOMER_PAGE_DEFAULT, 1), CUSTOMER_PAGE_MAX);
    return this.deps.repository.list(scope, search, limit, query.cursor ?? null);
  }

  /** Block. Idempotent, audited, and enforced by the server. */
  async block(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: UserId;
      readonly reason: string | null;
    },
  ): Promise<CustomerRecord> {
    return this.setStatus(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      to: 'BLOCKED',
      reason: input.reason,
    });
  }

  /** Unblock. The same machinery, so neither direction can forget a step. */
  async unblock(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: UserId;
      readonly reason: string | null;
    },
  ): Promise<CustomerRecord> {
    return this.setStatus(scope, actor, {
      idempotencyKey: input.idempotencyKey,
      customerId: input.customerId,
      to: 'ACTIVE',
      reason: input.reason,
    });
  }

  /**
   * Both directions, in one place.
   *
   * Two near-identical methods is how one of them eventually loses its audit row or its
   * activity check. The only asymmetry is the reason, which is stored on a block and
   * cleared on an unblock — a stale reason on an active customer would read as current.
   */
  private async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: UserId;
      readonly to: CustomerStatus;
      readonly reason: string | null;
    },
  ): Promise<CustomerRecord> {
    const reason =
      input.reason === null || input.reason.trim() === ''
        ? null
        : input.reason.trim().slice(0, BLOCK_REASON_MAX_LENGTH);
    const requestHash = hashRequest({ customerId: input.customerId, to: input.to, reason });

    const replay = await this.deps.idempotency.find<{ customerId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      return this.get(scope, actor, replay.result.customerId as UserId);
    }

    const now = this.deps.clock.now();
    const from: CustomerStatus = input.to === 'BLOCKED' ? 'ACTIVE' : 'BLOCKED';

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
      CUSTOMER_BLOCK_PERMISSION,
      {
        action: input.to === 'BLOCKED' ? 'customer.block' : 'customer.unblock',
        entityType: 'Customer',
        entityId: input.customerId,
      },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }

        const before = await this.deps.repository.findById(scope, input.customerId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const changed = await this.deps.repository.setStatus(
          scope,
          input.customerId,
          from,
          input.to,
          reason,
          now,
          tx,
        );

        /*
         * A no-op is still an authorized, audited, idempotency-consuming outcome.
         *
         * `nexa-conventions` forbids reporting success for a write that changed
         * nothing, and this does not: the audit row records `changed: false`, so the log
         * distinguishes "blocked them" from "they were already blocked". What it does
         * NOT do is throw, because the end state the operator asked for holds — and a
         * double-clicked Block that failed the second time would teach an operator that
         * the button is unreliable.
         */
        const after = await this.deps.repository.findById(scope, input.customerId, tx);
        if (after === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: input.to === 'BLOCKED' ? 'customer.block' : 'customer.unblock',
            entityType: 'Customer',
            entityId: after.id,
            before: { status: before.status },
            after: { status: after.status, changed },
            result: 'SUCCESS',
            ...(reason === null ? {} : { reason }),
          },
          tx,
        );

        if (changed) {
          await this.deps.events.publish({
            eventType: input.to === 'BLOCKED' ? 'CustomerBlocked' : 'CustomerUnblocked',
            aggregateType: 'Customer',
            aggregateId: after.id,
            payload: { reason },
          });
        }

        await rememberOnce(
          this.deps.idempotency,
          scope,
          'WEB',
          input.idempotencyKey,
          requestHash,
          { customerId: after.id },
          tx,
        );

        return after;
      },
    );
  }
}

/**
 * The request hash an idempotency key is bound to.
 *
 * A key reused with a DIFFERENT payload is a caller bug and must be refused rather than
 * served the stale result — `nexa-conventions` says so, and the store enforces it once
 * it has a hash to compare. Stable key order so two calls with the same meaning hash
 * the same.
 */
function hashRequest(payload: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(payload, Object.keys(payload).sort()))
    .digest('hex');
}
