import {
  COMMERCE_ERROR_CODES,
  PAYMENT_AMOUNT_MAX_MINOR,
  PLATFORM_ERROR_CODES,
  errors,
  migrationOpeningReference,
  money,
  telegramUserIdSchema,
  userIdSchema,
  type ActorContext,
  type AuditWriter,
  type Clock,
  type CurrencyCode,
  type IdGenerator,
  type LedgerDirection,
  type OperationalEventRecorder,
  type PermissionKey,
  type SalesCurrencyCode,
  type TenantContext,
  type UnitOfWork,
  type UserId,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../../platform/access/application/permission-guard.js';
import {
  recordMutationDenial,
  runAuthorizedMutation,
} from '../../../platform/access/application/authorized-mutation.js';
import type { SessionRepository } from '../../../platform/identity/application/ports.js';
import type { ScopeActivityReader } from '../../../platform/system/application/record-ping.service.js';
import type { SettingsResolver } from '../../../control/settings/application/settings-resolver.js';
import type { OutboxWriter } from '../../../platform/eventing/infrastructure/outbox-writer.js';
import type { TransactionScope } from '../../../../infrastructure/persistence/unit-of-work.js';
import type { CustomerRepository } from '../../customers/application/ports.js';
import type { WalletEntryRecord, WalletRepository } from './ports.js';

/**
 * What the migration posts under. `SYSTEM_JOB` holds `SYSTEM_JOB_PERMISSIONS`, which is
 * `maintenance.run` alone, and the import is system work: the actor is
 * `systemJobActor('legacy-import:<run>', …)`. The check is MADE, never skipped by actor
 * type — an administrator holding `maintenance.run` passes it too, which is why this
 * service has no HTTP or Telegram surface at all (`docs/migration-opening-balance.md`).
 */
export const MIGRATION_OPENING_BALANCE_PERMISSION: PermissionKey = 'maintenance.run';

const AUDIT_ACTION = 'wallet.migration_opening_balance';

export interface MigrationOpeningBalanceDeps {
  readonly repository: Pick<WalletRepository, 'append' | 'lockCustomer' | 'findByReference'>;
  readonly customers: Pick<CustomerRepository, 'findById'>;
  readonly guard: PermissionGuard;
  readonly uow: UnitOfWork<TransactionScope>;
  readonly audit: AuditWriter;
  readonly opsLog: OperationalEventRecorder;
  readonly sessions: SessionRepository;
  readonly scopeActivity: ScopeActivityReader;
  readonly settings: SettingsResolver;
  readonly outbox: OutboxWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

/**
 * One customer's legacy balance, as the importer read it.
 *
 * `legacyBalanceMinor` is SIGNED — the legacy `user.Balance`, in minor units of
 * `currency`. Toman (`IRT`) has zero minor digits in this product, so a legacy Toman
 * figure is its own minor amount, unchanged.
 *
 * `telegramUserId` is the legacy `user.id`, and the service refuses it unless it is the
 * named customer's own `telegram_user_id`: the reference is derived from it, so a
 * mismatch would file one person's opening under another's identity.
 */
export interface MigrationOpeningBalanceCommand {
  readonly customerId: string;
  readonly telegramUserId: string;
  readonly legacyBalanceMinor: bigint;
  readonly currency: CurrencyCode;
}

/**
 * What happened, never a bare success.
 *
 * - `POSTED` — this call wrote the opening entry. `signedAmountMinor` is what the opening
 *   moved the wallet by (negative for a legacy debt) — a fact of this entry alone.
 *
 *   Deliberately NO after-balance. Ordinary credits do not take the customer lock (only
 *   debits do), so a credit committing while this transaction runs is invisible to any
 *   balance read here and present in the real wallet a moment later. A balance this
 *   service reported, or audited as "after", would be a snapshot presented as the truth.
 *   The ledger is the balance; read it when one is needed.
 * - `ALREADY_POSTED` — an identical opening was already in the ledger (a rerun, a resume,
 *   a racing importer). Nothing written, no event, no audit row.
 * - `ZERO_NO_ENTRY` — the legacy balance is zero, and a zero entry cannot exist
 *   (`wallet_entries_amount_check`: amount > 0). The balance is already right, so nothing
 *   is written; the importer's own run metadata records the decision.
 */
export type MigrationOpeningBalanceOutcome =
  | {
      readonly kind: 'POSTED';
      readonly entry: WalletEntryRecord;
      readonly signedAmountMinor: bigint;
    }
  | { readonly kind: 'ALREADY_POSTED'; readonly entry: WalletEntryRecord }
  | { readonly kind: 'ZERO_NO_ENTRY' };

/**
 * Migration P2 — carries a legacy wallet balance into the ledger, once.
 *
 * ADDITIVE, never a set-balance: the entry is appended beside whatever the customer
 * already has, so a customer new to NEXA ends at the legacy balance and one who already
 * used NEXA ends at their NEXA balance plus the legacy one. There is no other mode.
 *
 * NEGATIVE balances: a negative legacy balance is a DEBIT of its magnitude, written
 * WITHOUT `canCover`. That is the whole of the exception, and it is this path's alone: the
 * debt already exists in the legacy system and is being recorded, not created.
 * `WalletService.adjust`, every purchase and every clawback still refuse to go below
 * zero, and a wallet that opens negative still refuses the next ordinary debit.
 *
 * IDEMPOTENT at the database: the reference is `legacy:opening:<telegram_user_id>`,
 * unique per tenant (`wallet_entries_tenant_reference_key`), backed by one opening per
 * customer (`wallet_entries_migration_opening_customer_key`). The reference IS this
 * command's idempotency key — derived, so it needs no idempotency row to survive a
 * crash. A rerun with a DIFFERENT figure is refused (`IDEMPOTENCY_PAYLOAD_MISMATCH`),
 * never silently answered with the first.
 *
 * Migration-only: no controller, no Telegram handler and no web page constructs or calls
 * this. The P7 importer (HOLD) is its intended and only caller.
 */
export class MigrationOpeningBalanceService {
  constructor(private readonly deps: MigrationOpeningBalanceDeps) {}

  async post(
    scope: TenantContext,
    actor: ActorContext,
    command: MigrationOpeningBalanceCommand,
  ): Promise<MigrationOpeningBalanceOutcome> {
    const customerId = this.customerId(command.customerId);
    const telegramUserId = this.telegramUserId(command.telegramUserId);
    const reference = migrationOpeningReference(telegramUserId);
    const magnitude =
      command.legacyBalanceMinor < 0n ? -command.legacyBalanceMinor : command.legacyBalanceMinor;
    if (magnitude > PAYMENT_AMOUNT_MAX_MINOR) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A legacy opening balance is within the amount ceiling.',
      );
    }
    const direction: LedgerDirection = command.legacyBalanceMinor < 0n ? 'DEBIT' : 'CREDIT';
    const denial = { action: AUDIT_ACTION, entityType: 'Wallet', entityId: customerId as string };

    // Charged before anything is read, and audited when refused.
    try {
      await this.deps.guard.check(scope, actor, MIGRATION_OPENING_BALANCE_PERMISSION);
    } catch (error) {
      await recordMutationDenial(
        this.mutationDeps(),
        scope,
        actor,
        MIGRATION_OPENING_BALANCE_PERMISSION,
        denial,
        error,
      );
      throw error;
    }

    return runAuthorizedMutation(
      this.mutationDeps(),
      scope,
      actor,
      MIGRATION_OPENING_BALANCE_PERMISSION,
      denial,
      async (tx) => {
        if (!(await this.deps.scopeActivity.scopeIsActive(scope, tx))) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'This installation has stopped accepting work.',
          );
        }
        const customer = await this.deps.customers.findById(scope, customerId, tx);
        if (customer === null) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }
        if (customer.telegramUserId !== telegramUserId) {
          throw errors.validation(
            COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
            'The legacy identity is not this customer’s Telegram id.',
          );
        }
        const selling = await this.deps.settings.valueOf<SalesCurrencyCode>(
          scope,
          'sales.currency',
          tx,
        );
        if (command.currency !== selling) {
          throw errors.conflict(
            COMMERCE_ERROR_CODES.WALLET_CURRENCY_UNSUPPORTED,
            `This installation sells in ${selling}.`,
          );
        }

        /*
         * The wallet lock, as every movement takes it. A negative opening decides nothing
         * from the balance, but an ordinary debit racing it must see it: under this lock
         * the debit's sufficiency read comes after the opening commits.
         */
        if (!(await this.deps.repository.lockCustomer(scope, customerId, tx))) {
          throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
        }

        const existing = await this.deps.repository.findByReference(scope, reference, tx);
        if (existing !== null) {
          return {
            kind: 'ALREADY_POSTED',
            entry: this.sameOpening(existing, customerId, direction, magnitude, command.currency),
          };
        }
        if (magnitude === 0n) return { kind: 'ZERO_NO_ENTRY' };

        const { entry, inserted } = await this.deps.repository.append(
          scope,
          {
            id: this.deps.ids.uuid(),
            customerId,
            direction,
            reason: 'MIGRATION_OPENING_BALANCE',
            amount: money(magnitude, command.currency),
            reference,
            actorAdminId: null,
            note: null,
            now: this.deps.clock.now(),
          },
          tx,
        );
        if (!inserted) {
          return {
            kind: 'ALREADY_POSTED',
            entry: this.sameOpening(entry, customerId, direction, magnitude, command.currency),
          };
        }
        const signedAmountMinor = direction === 'CREDIT' ? magnitude : -magnitude;

        await this.deps.audit.record(
          scope,
          actor,
          {
            action: AUDIT_ACTION,
            entityType: 'Wallet',
            entityId: entry.customerId,
            // No balance, before or after: see `MigrationOpeningBalanceOutcome`.
            before: null,
            after: {
              entryId: entry.id,
              direction: entry.direction,
              reason: entry.reason,
              amountMinor: entry.amount.amountMinor.toString(),
              currency: entry.amount.currency,
              signedAmountMinor: signedAmountMinor.toString(),
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
        return { kind: 'POSTED', entry, signedAmountMinor };
      },
    );
  }

  /**
   * The entry already under this reference, if it is the SAME opening; otherwise a
   * refusal. A different figure on a rerun means the source changed or the importer is
   * wrong, and answering with the first figure would hide it.
   */
  private sameOpening(
    existing: WalletEntryRecord,
    customerId: UserId,
    direction: LedgerDirection,
    magnitude: bigint,
    currency: CurrencyCode,
  ): WalletEntryRecord {
    const same =
      existing.reason === 'MIGRATION_OPENING_BALANCE' &&
      existing.customerId === customerId &&
      existing.direction === direction &&
      existing.amount.amountMinor === magnitude &&
      existing.amount.currency === currency;
    if (!same) {
      throw errors.conflict(
        PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
        'This customer’s opening balance was already posted with a different figure.',
      );
    }
    return existing;
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

  private telegramUserId(candidate: string): string {
    const parsed = telegramUserIdSchema.safeParse(candidate);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a Telegram user id.',
      );
    }
    return parsed.data;
  }
}
