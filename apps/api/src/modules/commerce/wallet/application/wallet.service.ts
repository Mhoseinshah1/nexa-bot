import {
  COMMERCE_ERROR_CODES,
  WALLET_PAGE_DEFAULT,
  WALLET_PAGE_MAX,
  errors,
  isValidLedgerAmount,
  money,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type IdempotencyStore,
  type LedgerDirection,
  type LedgerReason,
  type OperationId,
  type PermissionKey,
  type SalesCurrencyCode,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { OperationalEventRecorder } from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import { rememberOnce } from '../../../platform/idempotency/application/remember-once.js';
import { hashRequest } from '../../../platform/idempotency/infrastructure/drizzle-idempotency-store.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import { canCover, shortfallMinor } from '../domain/balance.js';
import type {
  WalletBalance,
  WalletCursor,
  WalletEntryPage,
  WalletEntryRecord,
  WalletRepository,
} from './ports.js';

/**
 * The permissions this service charges, all from the FROZEN vocabulary.
 *
 * Reading a wallet is `users.view`: a balance is a property of a customer, and an
 * operator who may open a customer may see what they are owed. Moving money is two
 * SEPARATE permissions, and their risk labels in `permissions.ts` say why they are not
 * one — `users.wallet.credit` is HIGH and `users.wallet.debit` is CRITICAL. Giving a
 * support agent the ability to fix a mistake by crediting is a different decision from
 * giving them the ability to take money away.
 *
 * None of these is new. `docs/phase4c-audit.md` §7 records that the whole financial
 * permission set already existed and that ROLE_SEEDS is not widened by this phase.
 */
export const WALLET_VIEW_PERMISSION: PermissionKey = 'users.view';
export const WALLET_CREDIT_PERMISSION: PermissionKey = 'users.wallet.credit';
export const WALLET_DEBIT_PERMISSION: PermissionKey = 'users.wallet.debit';

/**
 * What a CUSTOMER reading their OWN balance acts under.
 *
 * `maintenance.run`, the key `CATALOG_BROWSE_PERMISSION` and `ORDER_PLACE_PERMISSION`
 * already use: this is system work triggered by a customer, `SYSTEM_JOB` holds that one
 * key and nothing else, and the check is MADE rather than skipped — authorization is
 * never decided by looking at an actor's type.
 *
 * Deliberately NOT `users.view`. That permission lets an operator read ANY customer's
 * balance, and charging it here would make a customer's own `/wallet` indistinguishable
 * in the audit log from an operator inspecting somebody. The method below takes no
 * customer id from the caller for the same reason.
 */
export const WALLET_OWN_VIEW_PERMISSION: PermissionKey = 'maintenance.run';

const WALLET_NAMESPACE = 'WEB' as const;

/**
 * The reason an administrative adjustment carries, derived from its direction.
 *
 * NOT a caller's choice. `ledger.ts` freezes `ADMINISTRATIVE_REASONS` as the set that
 * *"may only be produced by an administrative action, never by a flow"*, and letting a
 * request name its own reason would let an operator file a debit as a `PURCHASE` — a
 * movement that would then read, for ever, as a customer having bought something.
 */
const ADJUSTMENT_REASONS: Readonly<Record<LedgerDirection, LedgerReason>> = {
  CREDIT: 'ADMIN_CREDIT',
  DEBIT: 'ADMIN_DEBIT',
};

export interface WalletServiceDeps {
  readonly repository: WalletRepository;
  readonly customers: CustomerRepository;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly idempotency: IdempotencyStore;
  readonly scopeActivity: ScopeActivityReader;
  /** Reads `sales.currency`. A balance is denominated in what the tenant sells in. */
  readonly settings: SettingsResolver;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Derives a movement's reference from an idempotency key. See `referenceFor`. */
  readonly operationId: (idempotencyKey: string) => OperationId;
}

export interface WalletAdjustment {
  readonly idempotencyKey: string;
  readonly direction: LedgerDirection;
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
  readonly note: string;
}

export interface WalletHistoryQuery {
  readonly limit?: number;
  readonly cursor?: WalletCursor;
}

/**
 * The administrator behind an actor, or null when there is not one.
 *
 * `wallet_entries.actor_admin_id` references `admins.id`, so this must be an ADMIN's
 * id or nothing — a `SYSTEM_JOB`'s null id would violate the foreign key and a
 * `CUSTOMER`'s id is a customer. Both admin surfaces are included: `permissions.ts`
 * governs a Telegram admin and a web admin with one vocabulary, and an adjustment made
 * from either is the same fact about the same person.
 *
 * The column's own comment says what it is for: *"Who caused it, when that was an
 * administrator rather than a flow."* That distinction is the answer to "did a person
 * do this", which `LGR-BR-063` records the legacy log as unable to give — it records
 * the actor but never the reason, and nothing at all for any admin mutation other than
 * a wallet adjustment and a receipt approval (`LGR-BR-083`).
 */
function adminIdOf(actor: ActorContext): string | null {
  return actor.type === 'WEB_ADMIN' || actor.type === 'TELEGRAM_ADMIN' ? actor.id : null;
}

/**
 * The wallet, as an operator sees it and as the rest of the system spends it.
 *
 * There is no `setBalance` and there is nowhere to put one. Every method here either
 * reads the ledger or appends to it, which is the whole of what a wallet is in this
 * system — the legacy `صفر کردن موجودی` ("zero the balance") button is a set-balance
 * in disguise and has no ledger reason that could honestly describe it.
 */
export class WalletService {
  constructor(private readonly deps: WalletServiceDeps) {}

  /**
   * A customer's balance, in the currency the installation sells in.
   *
   * The currency is resolved from `sales.currency` rather than taken from the caller:
   * a balance is a single number only once a denomination is fixed, and letting a
   * surface ask for an arbitrary one would let it render "0" for a customer who has
   * money, simply by asking in the wrong unit.
   */
  async balance(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
  ): Promise<WalletBalance> {
    await this.deps.guard.check(scope, actor, WALLET_VIEW_PERMISSION);
    const id = this.customerId(customerId);
    await this.assertCustomerExists(scope, id);
    return this.deps.repository.balanceOf(scope, id, await this.sellingCurrency(scope));
  }

  /**
   * The balance of the customer this turn RESOLVED. Not of a customer a caller names.
   *
   * The parameter is a `UserId` rather than a string, and it comes from the customer the
   * Telegram runtime resolved from the signed update — never from `callback_data`. That
   * is the whole difference between this and `balance` above: there is no id here a
   * client could have chosen, so there is no lookup to point at somebody else.
   */
  async balanceForCustomer(
    scope: TenantContext,
    actor: ActorContext,
    customerId: UserId,
  ): Promise<WalletBalance> {
    await this.deps.guard.check(scope, actor, WALLET_OWN_VIEW_PERMISSION);
    return this.deps.repository.balanceOf(scope, customerId, await this.sellingCurrency(scope));
  }

  /** A page of movements, newest first. Reading history is reading the customer. */
  async history(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    query: WalletHistoryQuery,
  ): Promise<WalletEntryPage> {
    await this.deps.guard.check(scope, actor, WALLET_VIEW_PERMISSION);
    const id = this.customerId(customerId);
    await this.assertCustomerExists(scope, id);
    const limit = Math.min(Math.max(query.limit ?? WALLET_PAGE_DEFAULT, 1), WALLET_PAGE_MAX);
    return this.deps.repository.list(scope, id, limit, query.cursor ?? null);
  }

  /**
   * An operator moving a customer's money by hand.
   *
   * The ONE place in this release that credits a wallet, and the reason the audit
   * records for that: a standalone top-up has no authoritative amount source, so the
   * only authority that may name an amount is an authenticated operator holding the
   * permission for the direction they are moving it in.
   *
   * Every guarantee is stacked here rather than spread out:
   *
   * - the permission is charged BEFORE the replay lookup, because a replay returns a
   *   committed movement and an actor who has lost the permission is not entitled to
   *   read one back (the shape `ProductService.authorize` records);
   * - the amount is checked against the ledger INSIDE the committing transaction, so a
   *   concurrent debit cannot be overtaken by this one;
   * - the append is idempotent at the unique index rather than in a process, so a
   *   retry, a double-click and two replicas produce one movement;
   * - the audit row and the `WalletEntryRecorded` event commit with the entry.
   */
  async adjust(
    scope: TenantContext,
    actor: ActorContext,
    customerId: string,
    input: WalletAdjustment,
  ): Promise<WalletEntryRecord> {
    const id = this.customerId(customerId);
    this.assertLedgerAmount(input.amountMinor);
    const permission =
      input.direction === 'CREDIT' ? WALLET_CREDIT_PERMISSION : WALLET_DEBIT_PERMISSION;
    const action = input.direction === 'CREDIT' ? 'wallet.credit' : 'wallet.debit';
    const denial = { action, entityType: 'Wallet', entityId: id as string };

    await this.authorize(scope, actor, permission, denial);

    const requestHash = hashRequest({
      customerId: id,
      direction: input.direction,
      amount: input.amountMinor.toString(),
      currency: input.currency,
      note: input.note,
    });
    const replay = await this.deps.idempotency.find<{ reference: string }>(
      scope,
      WALLET_NAMESPACE,
      input.idempotencyKey,
      requestHash,
    );
    if (replay !== null) {
      const existing = await this.deps.repository.findByReference(scope, replay.result.reference);
      if (existing !== null) return existing;
      // The idempotency row outlived its entry, which a restore can produce. Falling
      // through re-appends under the SAME reference, which the unique index makes
      // safe: it either writes the missing row or returns the one that is there.
    }

    const now = this.deps.clock.now();
    const reference = this.referenceFor(input.idempotencyKey, 'adjust');
    const entryId = this.deps.ids.uuid();

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      permission,
      denial,
      async (tx) => {
        await this.assertScopeActive(scope, tx);
        const customer = await this.deps.customers.findById(scope, id, tx);
        if (customer === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const selling = await this.sellingCurrency(scope, tx);
        if (input.currency !== selling) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED,
            `This installation sells in ${selling}.`,
          );
        }

        /*
         * The sufficiency check reads the ledger on THIS transaction's connection.
         *
         * That is what makes it a check rather than a guess: two concurrent debits both
         * read the balance, and the one that commits second sees the first's entry
         * because it is reading inside a transaction that started after it committed —
         * or blocks, and then sees it. A balance read on the pool before the transaction
         * would be a number from another moment.
         */
        if (input.direction === 'DEBIT') {
          /*
           * The customer row FIRST, then the balance.
           *
           * Without the lock two debits cannot see each other: the ledger is append-only,
           * so there is no shared row for two appends to contend on, and under READ
           * COMMITTED each `SUM` omits the other's uncommitted entry. Both then decide
           * they can cover and both commit. `financial-concurrency.test.ts` produced
           * exactly that and the wallet went to -250,000.
           */
          if (!(await this.deps.repository.lockCustomer(scope, id, tx))) {
            throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
          }
          const balance = await this.deps.repository.balanceOf(scope, id, input.currency, tx);
          if (!canCover(balance.amountMinor, input.amountMinor)) {
            throw errors.conflict(
              COMMERCE_ERROR_CODES.WALLET_INSUFFICIENT_FUNDS,
              'This wallet does not hold enough for that debit.',
              {
                shortfallMinor: shortfallMinor(balance.amountMinor, input.amountMinor).toString(),
                currency: input.currency,
              },
            );
          }
        }

        const entry = await this.deps.repository.append(
          scope,
          {
            id: entryId,
            customerId: id,
            direction: input.direction,
            reason: ADJUSTMENT_REASONS[input.direction],
            amount: money(input.amountMinor, input.currency),
            reference,
            actorAdminId: adminIdOf(actor),
            note: input.note,
            now,
          },
          tx,
        );

        await this.deps.audit.record(
          scope,
          actor,
          {
            action,
            entityType: 'Wallet',
            entityId: entry.customerId,
            before: null,
            after: {
              entryId: entry.id,
              direction: entry.direction,
              reason: entry.reason,
              amountMinor: entry.amount.amountMinor.toString(),
              currency: entry.amount.currency,
              reference: entry.reference,
              note: entry.note,
            },
            result: 'SUCCESS',
          },
          tx,
        );

        await this.deps.outbox.write(tx, actor, {
          eventType: 'WalletEntryRecorded',
          aggregateType: 'Wallet',
          aggregateId: entry.customerId,
          payload: {
            customerId: entry.customerId,
            entryId: entry.id,
            direction: entry.direction,
            reason: entry.reason,
            amountMinor: entry.amount.amountMinor.toString(),
            currency: entry.amount.currency,
          },
        });

        await rememberOnce(
          this.deps.idempotency,
          scope,
          WALLET_NAMESPACE,
          input.idempotencyKey,
          requestHash,
          { reference: entry.reference },
          tx,
        );
        return entry;
      },
    );
  }

  /**
   * A movement's idempotency identity, DERIVED and never generated.
   *
   * `operation.ts` states the property this rests on: a derived id needs no storage,
   * so *"the same key always yields the same operation id, in any process, after any
   * restart, with no lookup — so two replicas racing the same retry agree without
   * talking to each other."* A generated reference would have to be stored to survive
   * a retry, and the place it would be stored is the idempotency row, so a retry that
   * missed that row would mint a second reference and move the money twice.
   *
   * The `role` suffix is not decoration. One command may one day append two entries —
   * a debit and a fee, say — and two entries under one reference is a unique-index
   * violation that would surface as a failed command rather than as the design error
   * it is. Naming the role now means the scheme extends without a collision.
   */
  private referenceFor(idempotencyKey: string, role: string): string {
    return `${this.deps.operationId(idempotencyKey)}:${role}`;
  }

  private async sellingCurrency(
    scope: TenantContext,
    tx?: TransactionScope,
  ): Promise<SalesCurrencyCode> {
    return this.deps.settings.valueOf<SalesCurrencyCode>(scope, 'sales.currency', tx);
  }

  private async assertCustomerExists(scope: TenantContext, id: UserId): Promise<void> {
    if ((await this.deps.customers.findById(scope, id)) === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
  }

  /** Charges the permission before the replay, and audits the refusal. See `adjust`. */
  private async authorize(
    scope: TenantContext,
    actor: ActorContext,
    permission: PermissionKey,
    denial: { action: string; entityType: string; entityId: string | null },
  ): Promise<void> {
    try {
      await this.deps.guard.check(scope, actor, permission);
    } catch (error) {
      await recordMutationDenial(this.mutationDeps(), scope, actor, permission, denial, error);
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

  /**
   * A positive amount within the ceiling, or a 400.
   *
   * The HTTP schema checks the same thing, and this is not a duplicate of it: the
   * schema guards ONE caller, and `payment.ts` says where this invariant actually gets
   * violated — *"a service that computes a delta and stores it"*, which is a caller
   * that never passes through a zod schema at all. `wallet_entries_amount_check` is
   * the last line and it answers with an integrity error, which is a 500 for what is
   * an ordinary refusal.
   */
  private assertLedgerAmount(amountMinor: bigint): void {
    if (!isValidLedgerAmount(amountMinor)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A wallet movement is greater than zero and within the amount ceiling.',
      );
    }
  }

  /** A customer id, or a 400. `customers.id` is a `uuid` column. See `productId`. */
  private customerId(candidate: string): UserId {
    const parsed = userIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a customer id.',
      );
    }
    return parsed.data;
  }
}
