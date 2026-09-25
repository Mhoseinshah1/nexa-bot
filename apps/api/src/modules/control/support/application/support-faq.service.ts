import {
  COMMERCE_ERROR_CODES,
  SUPPORT_FAQ_MAX_ENTRIES,
  errors,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PermissionKey,
  type SupportFaqInput,
  type SupportFaqStatus,
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
import type { SupportFaqRecord, SupportFaqRepository } from './ports.js';
import type { SupportFaqSeeder } from './support-screen.reader.js';

export const SUPPORT_FAQ_VIEW_PERMISSION = 'settings.view' satisfies PermissionKey;
export const SUPPORT_FAQ_EDIT_PERMISSION = 'settings.edit' satisfies PermissionKey;

export interface SupportFaqServiceDeps {
  readonly repository: SupportFaqRepository;
  readonly seeder: SupportFaqSeeder;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  readonly ids: IdGenerator;
  readonly clock: Clock;
}

/** What one command produced, so a replay can answer with the same row. */
interface FaqResult {
  readonly id: string;
}

/**
 * The tenant's FAQ as the operator maintains it (customer UX completion §J).
 *
 * One read under `settings.view` and three writes under `settings.edit` — the support
 * page is configuration, and it sits beside the settings page whose `support.accounts`
 * editor is the destination the FAQ footer points at. The three writes are separate
 * commands with separate audit actions for the reason `PaymentGatewayService` gives:
 * folding "switch this entry off" into the edit would make "who hid this answer, and
 * when" answerable only by diffing two payloads.
 *
 * Every write states the version it read. A row that moved since — another operator's
 * edit, or this operator's own in another tab — is refused with the CURRENT version in
 * the detail, so the editor can offer the fresh row rather than overwrite it.
 *
 * The customer's read is `SupportScreenReader`, not here: it charges no permission,
 * and a class that mixed a customer read with operator writes would invite a caller to
 * hand the customer's path an actor it does not have.
 */
export class SupportFaqService {
  constructor(private readonly deps: SupportFaqServiceDeps) {}

  /**
   * Every row, whatever its status, in the customer's order.
   *
   * Seeds first, for the same reason the customer's screen does: §J says the defaults
   * are copied in the first time the FAQ is "read or listed", and an operator who opens
   * the page before any customer has tapped it must see the nine rows the customer will
   * see, not an empty table that fills itself later.
   */
  async listForOperator(
    scope: TenantContext,
    actor: ActorContext,
  ): Promise<readonly SupportFaqRecord[]> {
    await this.deps.guard.check(scope, actor, SUPPORT_FAQ_VIEW_PERMISSION);
    await this.deps.seeder.ensureSeeded(scope);
    return this.deps.repository.list(scope);
  }

  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: SupportFaqInput & { readonly idempotencyKey: string },
  ): Promise<SupportFaqRecord> {
    const denial = { action: 'support_faq.create', entityType: 'SupportFaq', entityId: null };
    // Before the replay lookup, the rule `PaymentAccountService.create` states: a replay
    // returns a ROW, and an unauthorized caller who guessed a key would be handed one.
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      question: input.question,
      answer: input.answer,
      sortOrder: input.sortOrder,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_FAQ_EDIT_PERMISSION,
      { ...denial, entityId: id },
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        /*
         * Counted inside the transaction, and it is a bound rather than a lock: two
         * operators racing at ninety-nine may both succeed. The limit exists so the
         * screen stays a handful of messages, and one entry over it costs nothing a
         * lock would be worth.
         */
        if ((await this.deps.repository.count(scope, tx)) >= SUPPORT_FAQ_MAX_ENTRIES) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.SUPPORT_FAQ_LIMIT,
            `This installation already holds ${String(SUPPORT_FAQ_MAX_ENTRIES)} FAQ entries.`,
            { limit: SUPPORT_FAQ_MAX_ENTRIES },
          );
        }
        const after = await this.deps.repository.insert(
          scope,
          {
            id,
            question: input.question,
            answer: input.answer,
            sortOrder: input.sortOrder,
            status: 'ACTIVE',
            now,
          },
          tx,
        );
        await this.record(scope, actor, tx, {
          action: 'support_faq.create',
          entityId: id,
          before: null,
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, id, tx);
        return after;
      },
    );
  }

  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: SupportFaqInput & {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly expectedVersion: number;
    },
  ): Promise<SupportFaqRecord> {
    const denial = { action: 'support_faq.update', entityType: 'SupportFaq', entityId: input.id };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      id: input.id,
      question: input.question,
      answer: input.answer,
      sortOrder: input.sortOrder,
      expectedVersion: input.expectedVersion,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_FAQ_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, input.id, tx);
        this.assertVersion(before, input.expectedVersion);

        const after = await this.deps.repository.update(
          scope,
          input.id,
          {
            question: input.question,
            answer: input.answer,
            sortOrder: input.sortOrder,
            expectedVersion: input.expectedVersion,
          },
          now,
          tx,
        );
        // Zero rows means the row moved between the read and the write. Re-read for
        // the version the refusal should name, then refuse as the early check would.
        if (after === null) throw this.versionConflict(await this.require(scope, input.id, tx));

        await this.record(scope, actor, tx, {
          action: 'support_faq.update',
          entityId: input.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
        return after;
      },
    );
  }

  /**
   * Switches one entry on or off.
   *
   * A no-op when the entry is already in the requested status, and it says so by
   * returning the row unchanged with NO audit row and NO version bump — the gateway
   * rule: an audit entry for a change that did not happen is the legacy activity feed.
   * The transition is a conditional UPDATE naming `from` AND the version, so two
   * operators racing produce one change and one refusal.
   */
  async setStatus(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly id: string;
      readonly status: SupportFaqStatus;
      readonly expectedVersion: number;
    },
  ): Promise<SupportFaqRecord> {
    const denial = { action: 'support_faq.status', entityType: 'SupportFaq', entityId: input.id };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({
      id: input.id,
      status: input.status,
      expectedVersion: input.expectedVersion,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      SUPPORT_FAQ_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, input.id, tx);
        this.assertVersion(before, input.expectedVersion);
        if (before.status === input.status) {
          await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
          return before;
        }

        const after = await this.deps.repository.setStatus(
          scope,
          input.id,
          { from: before.status, to: input.status, expectedVersion: input.expectedVersion },
          now,
          tx,
        );
        if (after === null) throw this.versionConflict(await this.require(scope, input.id, tx));

        await this.record(scope, actor, tx, {
          action: 'support_faq.status',
          entityId: input.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, input.id, tx);
        return after;
      },
    );
  }

  // -------------------------------------------------------------------------

  /**
   * The row this tenant holds under that id, or `SUPPORT_FAQ_NOT_FOUND`.
   *
   * Another tenant's id is answered identically: the repository's predicate carries the
   * tenant, so the row is simply not there, and a distinct "belongs to somebody else"
   * would confirm to a caller that the id exists.
   */
  private async require(
    scope: TenantContext,
    id: string,
    tx: TransactionScope,
  ): Promise<SupportFaqRecord> {
    const found = await this.deps.repository.find(scope, id, tx);
    if (found === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.SUPPORT_FAQ_NOT_FOUND, 'No such FAQ entry.');
    }
    return found;
  }

  private assertVersion(row: SupportFaqRecord, expectedVersion: number): void {
    if (row.version !== expectedVersion) throw this.versionConflict(row);
  }

  /** The refusal carries the CURRENT version, which is what an editor needs to recover. */
  private versionConflict(row: SupportFaqRecord): Error {
    return errors.conflict(
      COMMERCE_ERROR_CODES.SUPPORT_FAQ_VERSION_CONFLICT,
      'This FAQ entry changed since it was read. Reload it and apply the change again.',
      { currentVersion: row.version },
    );
  }

  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<SupportFaqRecord | null> {
    const found = await this.deps.idempotency.find<FaqResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    // Null when the idempotency row outlived its entry, which a restore can produce:
    // falling through and doing the work beats reporting a stale success.
    return this.deps.repository.find(scope, found.result.id);
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    id: string,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { id } satisfies FaqResult,
      tx,
    );
  }

  private async record(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    entry: {
      readonly action: string;
      readonly entityId: string;
      readonly before: Record<string, unknown> | null;
      readonly after: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: entry.action,
        entityType: 'SupportFaq',
        entityId: entry.entityId,
        before: entry.before,
        after: entry.after,
        result: 'SUCCESS',
      },
      tx,
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

  /** `recordMutationDenial`, not a bare check — see `ProductService.authorize`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, SUPPORT_FAQ_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        SUPPORT_FAQ_EDIT_PERMISSION,
        denial,
        error,
      );
      throw error;
    }
  }

  private async assertScopeActive(scope: TenantContext, tx: TransactionScope): Promise<void> {
    if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
      throw errors.conflict(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'This installation has stopped accepting work.',
      );
    }
  }
}

/** Every mutable field plus the version, so a before/after pair answers what an edit changed. */
function auditView(row: SupportFaqRecord): Record<string, unknown> {
  return {
    question: row.question,
    answer: row.answer,
    status: row.status,
    sortOrder: row.sortOrder,
    version: row.version,
  };
}
