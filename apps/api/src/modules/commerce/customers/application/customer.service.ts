import {
  COMMERCE_ERROR_CODES,
  CUSTOMER_BLOCK_REASON_MAX_LENGTH,
  CUSTOMER_PAGE_DEFAULT,
  CUSTOMER_PAGE_MAX,
  errors,
  profileFactsFrom,
  telegramUserIdSchema,
  userIdSchema,
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
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import { runAuthorizedMutation } from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
/*
 * The store's OWN hash, not a second one written here.
 *
 * The first version of this file had a private copy built on
 * `JSON.stringify(payload, Object.keys(payload).sort())`, which is not a key
 * sort — the second argument is a REPLACER ARRAY, and it applies at every
 * depth. `profile` is nested, so its keys were not in the list and the profile
 * serialised as `{}`: every Telegram resolve hashed to the same value whatever
 * the customer was called, so the one thing the hash exists to catch — a key
 * reused with a different payload — could not be caught. The store exports a
 * real recursive stable stringify; there is no reason for a second.
 */
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
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

/*
 * The page and reason bounds come from the CONTRACT, not from here.
 *
 * `http.ts` declares them because a bound a caller is held to is part of the interface.
 * Two copies would be two numbers to keep in step, and the one that drifts is the one a
 * schema refuses past while a service silently clamps to something else.
 */

export interface CustomerServiceDeps {
  readonly repository: CustomerRepository;
  readonly guard: PermissionGuard;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly idempotency: IdempotencyStore;
  /**
   * The transactional outbox, by its own interface rather than `EventPublisher`.
   *
   * `EventPublisher` declares `publish`; `OutboxWriter.write` is what every existing
   * module calls and what takes the transaction handle. Depending on the shape the
   * codebase actually has beats renaming a method to match a port nothing implements.
   */
  readonly outbox: OutboxWriter;
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

    /*
     * 3. Authorize BEFORE the replay lookup, not only inside the transaction.
     *
     * `runAuthorizedMutation` re-checks the permission inside the committing
     * transaction, which is the rule — but a replay never reaches it, and a replay
     * returns the customer. An unauthorized caller replaying somebody else's key
     * would have been answered with a row. The check is made twice on the first
     * call and exactly once on a replay, which is the shape every other command
     * here has.
     */
    await this.deps.guard.check(scope, actor, RESOLVE_CUSTOMER_PERMISSION);

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
      if (existing !== null) {
        /*
         * The arrival is RECOMPUTED for a blocked customer, never replayed.
         *
         * The stored arrival is a fact about the first processing; `status` is a fact
         * about now. An operator can block somebody between the two, and Telegram can
         * redeliver an update whose response was lost — which is the whole reason this
         * replay branch exists. Returning the stored `FIRST_SEEN` or `RETURNING`
         * alongside a row that is now BLOCKED made `replyFor` greet a blocked customer,
         * because it decides from the arrival alone.
         *
         * So the one rule that outranks everything is re-derived here rather than
         * trusted from the record. `FIRST_SEEN` and `RETURNING` are still replayed
         * verbatim: the difference between them is a fact about the first processing and
         * does not change afterwards.
         *
         * Found by review. M6 mutated `replyFor`'s BLOCKED branch and was killed by two
         * tests — both on the NON-replay path, so neither could see this.
         */
        const arrival: CustomerArrival =
          existing.status === 'BLOCKED' ? 'BLOCKED' : replay.result.arrival;
        return { customer: existing, arrival };
      }
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
          // The TransactionScope, not the tenant scope: the writer takes the open
          // transaction so the event row commits with the customer row. A domain event
          // written outside the business transaction is an event that can exist for a
          // change that rolled back.
          await this.deps.outbox.write(tx, actor, {
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
  async get(scope: TenantContext, actor: ActorContext, id: string): Promise<CustomerRecord> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW_PERMISSION);
    const found = await this.deps.repository.findById(scope, this.customerId(id));
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

  /**
   * A customer id, or a refusal that is not a 500.
   *
   * `customers.id` is a `uuid` column, so a path segment that is not one reaches
   * PostgreSQL as `invalid input syntax for type uuid` — an unhandled error, logged as
   * an internal failure, answered as 500. That is exactly the defect `panels.id` had and
   * `panelId` was added for, and `userIdSchema` is the contract's own answer: a UUIDv7,
   * LOWER-CASED. The lower-casing is the load-bearing half. Postgres compares `uuid`
   * values case-insensitively, so `…89AB` and `…89ab` are one row while JavaScript `===`
   * says they are two — which is how the admin self-modification guard was once defeated
   * by re-casing an id in the path.
   *
   * Validated HERE rather than in the controller so a Telegram admin surface added later
   * inherits the rule instead of rediscovering it.
   *
   * Stricter than the cursor, deliberately: `keyset-cursor.ts` accepts any uuid version
   * because the id it carries only ever feeds a `>` comparison, while this one RESOLVES A
   * PERSON and a customer of this installation is always a v7 because `ids.uuid()` makes
   * them.
   */
  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    return parsed.data;
  }

  /** Block. Idempotent, audited, and enforced by the server. */
  async block(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly customerId: string;
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
      readonly customerId: string;
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
      readonly customerId: string;
      readonly to: CustomerStatus;
      readonly reason: string | null;
    },
  ): Promise<CustomerRecord> {
    // Before the hash, so a re-cased id cannot produce a second idempotency record for
    // the same command against the same row.
    const customerId = this.customerId(input.customerId);
    const reason =
      input.reason === null || input.reason.trim() === ''
        ? null
        : input.reason.trim().slice(0, CUSTOMER_BLOCK_REASON_MAX_LENGTH);
    const requestHash = hashRequest({ customerId, to: input.to, reason });

    /*
     * Authorize the replay under the COMMAND's permission, not under `users.view`.
     *
     * This called `this.get`, which checks `users.view` — so an actor holding
     * `users.block` and not `users.view` could block a customer on the first call
     * and was denied on the replay of the same key. A replay must be the same
     * decision as the call it replays, or a retry after a timeout reports a
     * permission failure for a write that already happened.
     */
    await this.deps.guard.check(scope, actor, CUSTOMER_BLOCK_PERMISSION);

    const replay = await this.deps.idempotency.find<{ customerId: string }>(
      scope,
      'WEB',
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const replayed = await this.deps.repository.findById(
        scope,
        replay.result.customerId as UserId,
      );
      if (replayed !== null) return replayed;
      // The idempotency row outlived its customer, which a restore can produce.
      // Falling through redoes a command that is idempotent by construction; the
      // conditional UPDATE below finds no row and the caller gets a 404, which is
      // the truth rather than a stale success.
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
        entityId: customerId,
      },
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }

        const before = await this.deps.repository.findById(scope, customerId, tx);
        if (before === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const changed = await this.deps.repository.setStatus(
          scope,
          customerId,
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
        const after = await this.deps.repository.findById(scope, customerId, tx);
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
          await this.deps.outbox.write(tx, actor, {
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
