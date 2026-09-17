import {
  COMMERCE_ERROR_CODES,
  PAYMENT_ACCOUNT_MAX_PER_TENANT,
  errors,
  paymentAccountIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type IdGenerator,
  type IdempotencyStore,
  type OperationalEventRecorder,
  type PaymentAccountId,
  type PermissionKey,
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
import { isUniqueViolation } from '../../../../infrastructure/persistence/sqlstate.js';
import type {
  PaymentAccountFields,
  PaymentAccountRecord,
  PaymentAccountRepository,
} from './account-ports.js';

export const PAYMENT_ACCOUNT_VIEW_PERMISSION = 'payments.accounts.view' satisfies PermissionKey;
export const PAYMENT_ACCOUNT_EDIT_PERMISSION = 'payments.accounts.edit' satisfies PermissionKey;

export interface PaymentAccountServiceDeps {
  readonly repository: PaymentAccountRepository;
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

/** What one command was asked to do, so a replay can answer with the same row. */
interface AccountResult {
  readonly accountId: string;
}

/**
 * The manual-transfer destinations an operator configures.
 *
 * Four commands, deliberately separate — create, edit the fields, enable or disable, and
 * promote to default — because each answers a different operator question and each leaves
 * its own audit row. Folding "disable" into the edit would make "who moved the
 * destination, and when" answerable only by diffing two field sets.
 *
 * Everything here charges `payments.accounts.edit` except the two reads. Neither borrows
 * `settings.*`: `docs/phase5-audit.md` §4.7 records why, and the short version is that
 * `settings.edit` is owner-only, so a finance operator could not replace a blocked card.
 */
export class PaymentAccountService {
  constructor(private readonly deps: PaymentAccountServiceDeps) {}

  async list(scope: TenantContext, actor: ActorContext): Promise<readonly PaymentAccountRecord[]> {
    await this.deps.guard.check(scope, actor, PAYMENT_ACCOUNT_VIEW_PERMISSION);
    return this.deps.repository.list(scope);
  }

  /*
   * There is no `get`, deliberately.
   *
   * The list carries every field a surface needs and is complete by construction, so a
   * read-one would have had no route and no caller but a test. A service method whose
   * only caller is a test is a placeholder abstraction, which is the thing this codebase
   * refuses; the isolation it used to assert is asserted on the three paths that exist.
   */

  /**
   * Adds an account.
   *
   * An enabled account created when the tenant has NO selectable destination becomes the
   * default whatever `makeDefault` says. A real product rule rather than a convenience:
   * a tenant whose only enabled account is not the default has a configuration screen
   * that looks finished, and `selectDestination` falling back to the lowest-ordered
   * enabled row is a rescue rather than something to rely on.
   *
   * The COUNT is read inside the transaction and the limit checked against it. Two
   * creates racing at the ceiling can both pass — `PAYMENT_ACCOUNT_MAX_PER_TENANT` is a
   * rail that keeps the list complete, not a policy anybody is buying, and serialising
   * every create behind a lock to hold it exactly would cost more than it protects.
   */
  async create(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly fields: PaymentAccountFields;
      readonly enabled: boolean;
      readonly makeDefault: boolean;
    },
  ): Promise<PaymentAccountRecord> {
    const denial = {
      action: 'payment_account.create',
      entityType: 'PaymentAccount',
      entityId: null,
    };
    // Before the replay lookup: a replay returns a ROW carrying a card number, and
    // would hand it to anybody who guessed the key.
    await this.authorize(scope, actor, denial);

    /*
     * `makeDefault` is IN the hash.
     *
     * It was not, and two creates carrying the same key and the same fields but
     * different `makeDefault` hashed identically — so the second, the one asking for
     * the new account to become the destination, was answered with the first's row and
     * the default was never moved. A payload mismatch is what the store is for and this
     * is one. Found by the Codex review of PR #34.
     */
    const requestHash = hashRequest({
      ...input.fields,
      enabled: input.enabled,
      makeDefault: input.makeDefault,
    });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();
    const id = this.deps.ids.uuid() as PaymentAccountId;

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_ACCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);

        const held = await this.deps.repository.count(scope, tx);
        if (held >= PAYMENT_ACCOUNT_MAX_PER_TENANT) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_LIMIT_REACHED,
            `An installation may hold at most ${PAYMENT_ACCOUNT_MAX_PER_TENANT} payment accounts.`,
          );
        }

        /*
         * Read inside the transaction, so "is there already a default" and the INSERT
         * that depends on it cannot be separated by another operator's commit. The
         * partial unique index is still the thing that decides a true race; this is what
         * makes the ordinary case one statement rather than two.
         */
        /*
         * A disabled account cannot be asked to become the destination.
         *
         * `paymentAccountCreateRequestSchema` admits the pair, and this used to answer it
         * by evaluating `input.enabled && ...` to false: a disabled, non-default account
         * created successfully, and half of what the caller asked for silently dropped.
         * The same service already reports `PAYMENT_ACCOUNT_DISABLED` for promoting an
         * existing disabled account, so the contradiction is refused by the same name.
         * Silent success for a command that was not carried out is the legacy defect this
         * codebase is built against — `SBR-003`, an admin re-added and nothing written.
         * Found by the Codex review of PR #34.
         */
        if (!input.enabled && input.makeDefault) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
            'A disabled account cannot be the destination. Create it enabled, or do not make it the default.',
          );
        }

        const existingDefault =
          input.enabled && (await this.deps.repository.selectDestination(scope, tx));
        const isDefault = input.enabled && (input.makeDefault || existingDefault === null);

        if (isDefault) await this.deps.repository.clearDefault(scope, now, tx);

        const created = await this.guardDuplicates(() =>
          this.deps.repository.create(
            scope,
            { id, fields: input.fields, enabled: input.enabled, isDefault, now },
            tx,
          ),
        );

        await this.record(scope, actor, tx, {
          action: 'payment_account.create',
          entityId: created.id,
          before: null,
          after: auditView(created),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, created.id, tx);
        return created;
      },
    );
  }

  /**
   * Edits the account's own fields, and nothing about where money currently goes.
   *
   * It does not touch a payment already issued against this account — that is what
   * `payment_destinations` is for, and it is enforced by a trigger rather than by this
   * sentence.
   */
  async update(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly accountId: string;
      readonly fields: PaymentAccountFields;
    },
  ): Promise<PaymentAccountRecord> {
    const accountId = this.accountId(input.accountId);
    const denial = {
      action: 'payment_account.update',
      entityType: 'PaymentAccount',
      entityId: accountId,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({ accountId, ...input.fields });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_ACCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, accountId, tx);

        const after = await this.guardDuplicates(() =>
          this.deps.repository.update(scope, accountId, input.fields, now, tx),
        );
        if (after === null) {
          throw errors.notFound(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_NOT_FOUND,
            'Unknown payment account.',
          );
        }

        await this.record(scope, actor, tx, {
          action: 'payment_account.update',
          entityId: after.id,
          before: auditView(before),
          after: auditView(after),
        });
        await this.remember(scope, input.idempotencyKey, requestHash, after.id, tx);
        return after;
      },
    );
  }

  /**
   * Enables or disables one account.
   *
   * Disabling the DEFAULT is refused rather than answered by promoting somebody else.
   * Which account money should arrive in next is a decision with a person behind it, and
   * a system that picks one has made a financial choice nobody recorded.
   */
  async setEnabled(
    scope: TenantContext,
    actor: ActorContext,
    input: {
      readonly idempotencyKey: string;
      readonly accountId: string;
      readonly enabled: boolean;
    },
  ): Promise<PaymentAccountRecord> {
    const accountId = this.accountId(input.accountId);
    const denial = {
      action: 'payment_account.set_enabled',
      entityType: 'PaymentAccount',
      entityId: accountId,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({ accountId, enabled: input.enabled });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_ACCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, accountId, tx);

        /*
         * Read first so the ordinary case gets the sentence that names the remedy. It is
         * NOT the enforcement: another operator can promote this account between this
         * read and the UPDATE below, and `setEnabled`'s own predicate is what covers
         * that. Found by the Codex review of PR #34, which measured the consequence —
         * the disable passed this check, met `payment_accounts_default_enabled_check`,
         * and a CHECK violation is not a unique violation, so it escaped
         * `guardDuplicates` as a 500.
         */
        if (!input.enabled && before.isDefault) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
            'This is the default destination. Promote another account before disabling it.',
          );
        }

        /*
         * Re-enabling can collide with a live account holding the same card, so it goes
         * through the same duplicate guard a create does. Disabling never can — the
         * partial index is scoped to enabled rows — but the wrapper is on both because a
         * guard applied to one direction of a symmetric call is a guard somebody removes.
         */
        const after = await this.guardDuplicates(() =>
          this.deps.repository.setEnabled(scope, accountId, input.enabled, now, tx),
        );

        /*
         * Null means the UPDATE matched no row, and it is RE-READ rather than assumed.
         *
         * Three things produce it now that the predicate also names `is_default`: the row
         * was already in the state asked for, it became the default between the read
         * above and the statement, or it is gone. The first is a double-click and writes
         * no audit entry — a row saying an account was disabled, written when nothing
         * changed, is a record of something that did not happen. The second is the race
         * `payment_accounts_default_enabled_check` would otherwise have turned into a
         * 500, and it gets the refusal that names the remedy.
         *
         * Answering with `before` was wrong for a third reason the Codex review of PR #34
         * names: two concurrent disables under different keys both read
         * `before.enabled === true`, one wins, and the loser returned the row it had read
         * — reporting the account as still enabled while the database said otherwise,
         * and remembering that answer. So the CURRENT row is what is returned.
         */
        if (after === null) {
          const current = await this.deps.repository.findById(scope, accountId, tx);
          if (current === null) {
            throw errors.notFound(
              COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_NOT_FOUND,
              'Unknown payment account.',
            );
          }
          if (!input.enabled && current.isDefault) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
              'This is the default destination. Promote another account before disabling it.',
            );
          }
          await this.remember(scope, input.idempotencyKey, requestHash, current.id, tx);
          return current;
        }

        await this.record(scope, actor, tx, {
          action: 'payment_account.set_enabled',
          entityId: after.id,
          before: { enabled: before.enabled },
          after: { enabled: after.enabled },
        });
        await this.remember(scope, input.idempotencyKey, requestHash, after.id, tx);
        return after;
      },
    );
  }

  /** Promotes one enabled account to be the destination new payments are issued against. */
  async setDefault(
    scope: TenantContext,
    actor: ActorContext,
    input: { readonly idempotencyKey: string; readonly accountId: string },
  ): Promise<PaymentAccountRecord> {
    const accountId = this.accountId(input.accountId);
    const denial = {
      action: 'payment_account.set_default',
      entityType: 'PaymentAccount',
      entityId: accountId,
    };
    await this.authorize(scope, actor, denial);

    const requestHash = hashRequest({ accountId, makeDefault: true });
    const replayed = await this.replay(scope, input.idempotencyKey, requestHash);
    if (replayed !== null) return replayed;

    const now = this.deps.clock.now();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      PAYMENT_ACCOUNT_EDIT_PERMISSION,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const before = await this.require(scope, accountId, tx);
        if (before.isDefault) {
          await this.remember(scope, input.idempotencyKey, requestHash, before.id, tx);
          return before;
        }
        if (!before.enabled) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
            'A disabled account cannot be the destination. Enable it first.',
          );
        }

        /*
         * Clear, then set, in one transaction. The UPDATE that clears takes a row lock on
         * whichever account currently holds the default, so two operators promoting
         * different accounts serialise behind it and the second one clears the first's
         * winner before setting its own — exactly one default, whichever order they
         * arrive in.
         *
         * When there is NO current default the clear locks nothing, and then the partial
         * unique index is what decides: one commits, the other gets a 23505 that
         * `guardDuplicates` turns into a conflict the operator can retry.
         */
        const displaced = await this.deps.repository.clearDefault(scope, now, tx);
        const after = await this.guardDuplicates(() =>
          this.deps.repository.setDefault(scope, accountId, now, tx),
        );
        if (after === null) {
          // The row was enabled a moment ago and is not now. Another operator disabled it
          // between the read and this UPDATE, which is the race the conditional exists for.
          throw errors.conflict(
            COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DISABLED,
            'A disabled account cannot be the destination. Enable it first.',
          );
        }

        await this.record(scope, actor, tx, {
          action: 'payment_account.set_default',
          entityId: after.id,
          before: { isDefault: false, displaced },
          after: { isDefault: true },
        });
        await this.remember(scope, input.idempotencyKey, requestHash, after.id, tx);
        return after;
      },
    );
  }

  /**
   * A 23505 on either partial unique index, as a refusal rather than a 500.
   *
   * The two are told apart by NAME and never by a bare 23505, because they mean
   * different things to an operator: one says another live account already holds that
   * card, the other says somebody else became the default while this request was in
   * flight. `isUniqueViolation` walks the `cause` chain, which is what makes it work
   * through Drizzle's wrapper.
   */
  private async guardDuplicates<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (isUniqueViolation(error, 'payment_accounts_tenant_card_key')) {
        throw errors.conflict(
          COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DUPLICATE,
          'Another enabled account already holds that card number.',
        );
      }
      if (isUniqueViolation(error, 'payment_accounts_tenant_default_key')) {
        /*
         * Its own code since the Codex review of PR #34. It used to be
         * `PAYMENT_ACCOUNT_DUPLICATE`, which the contract documents as another ENABLED
         * account holding the same card number — a different fact, a different remedy,
         * and the only one of the two that is not retryable. The constraints were already
         * told apart here by name; the code they produced was not.
         */
        throw errors.conflict(
          COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_DEFAULT_CONFLICT,
          'Another account became the default while this request was in flight. Try again.',
        );
      }
      throw error;
    }
  }

  private async require(
    scope: TenantContext,
    id: PaymentAccountId,
    tx: TransactionScope,
  ): Promise<PaymentAccountRecord> {
    const account = await this.deps.repository.findById(scope, id, tx);
    if (account === null) {
      throw errors.notFound(
        COMMERCE_ERROR_CODES.PAYMENT_ACCOUNT_NOT_FOUND,
        'Unknown payment account.',
      );
    }
    return account;
  }

  /**
   * The replayed row, or null to go and do the work.
   *
   * Null is also the answer when the idempotency row outlived its account, which a
   * restore can produce: falling through and creating is better than reporting a stale
   * success for a row that is gone.
   */
  private async replay(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PaymentAccountRecord | null> {
    const found = await this.deps.idempotency.find<AccountResult>(
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
    );
    if (found === null) return null;
    return this.deps.repository.findById(scope, found.result.accountId as PaymentAccountId);
  }

  private async remember(
    scope: TenantContext,
    idempotencyKey: string,
    requestHash: string,
    accountId: PaymentAccountId,
    tx: TransactionScope,
  ): Promise<void> {
    await rememberOnce(
      this.deps.idempotency,
      scope,
      'WEB',
      idempotencyKey,
      requestHash,
      { accountId } satisfies AccountResult,
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
        entityType: 'PaymentAccount',
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
      await this.deps.guard.check(scope, actor, PAYMENT_ACCOUNT_EDIT_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        PAYMENT_ACCOUNT_EDIT_PERMISSION,
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

  /** A uuid, validated in the SERVICE so any later surface inherits the rule. */
  private accountId(candidate: string): PaymentAccountId {
    const parsed = paymentAccountIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid payment account identifier.',
      );
    }
    return parsed.data;
  }
}

/**
 * Every mutable field, so a before/after pair answers what an edit changed.
 *
 * The card number IS here, in full. An audit row that recorded "the card number
 * changed" without saying from what is the legacy `/admin/logs` — a free-text sentence
 * with no before and no after — and the whole point of auditing this table is being able
 * to answer "when did money start going somewhere else, and who moved it".
 *
 * That is a deliberate exception to nothing: `docs/conventions.md` forbids putting a
 * SECRET in an audit payload, and a card number this installation publishes to every
 * customer is not one.
 */
function auditView(account: PaymentAccountRecord): Record<string, unknown> {
  return {
    label: account.label,
    bankName: account.bankName,
    holderName: account.holderName,
    cardNumber: account.cardNumber,
    iban: account.iban,
    enabled: account.enabled,
    isDefault: account.isDefault,
    sortOrder: account.sortOrder,
  };
}
