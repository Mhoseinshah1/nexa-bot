import {
  COMMERCE_ERROR_CODES,
  LEGACY_WALLET_DEBT_AUDIT_ACTIONS,
  LEGACY_WALLET_DEBT_CURRENCY,
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
import type {
  LegacyWalletDebtRecord,
  LegacyWalletDebtRecorder,
} from '../../legacy-wallet-debts/application/ports.js';

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
  /** Mirza PR4: where a NEGATIVE legacy balance is recorded instead of the ledger. */
  readonly debts: LegacyWalletDebtRecorder;
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
  /**
   * Where the figure was read from. REQUIRED for a negative balance (the debt records it);
   * a positive or zero opening does not store it (the ledger row's reference is its key).
   */
  readonly provenance?: MigrationOpeningProvenance;
}

/** The snapshot a legacy figure was read from, and the import run that read it. */
export interface MigrationOpeningProvenance {
  readonly runId: string;
  /** The v1 source fingerprint of the snapshot. */
  readonly sourceFingerprint: string;
  /** The legacy user row's `user:v1` checksum in that snapshot. */
  readonly rowChecksum: string;
  /** The snapshot carried the synthetic-fixture marker. */
  readonly synthetic: boolean;
}

/**
 * What happened, never a bare success.
 *
 * - `POSTED` — this call wrote the opening entry. `signedAmountMinor` is what the opening
 *   moved the wallet by — a fact of this entry alone. Always positive since owner decision
 *   6: a negative legacy balance is a legacy debt (`DEBT_RECORDED`), never an entry.
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
  | { readonly kind: 'ZERO_NO_ENTRY' }
  /**
   * Mirza PR4 (owner decision 6): a NEGATIVE legacy balance was recorded as a legacy debt —
   * NO ledger entry, the NEXA balance untouched. `amountMinor` is the magnitude owed.
   */
  | {
      readonly kind: 'DEBT_RECORDED';
      readonly debt: LegacyWalletDebtRecord;
      readonly amountMinor: bigint;
    }
  /** The SAME debt was already recorded (a rerun, a resume, a racing importer). Nothing written. */
  | { readonly kind: 'DEBT_ALREADY_RECORDED'; readonly debt: LegacyWalletDebtRecord }
  /**
   * The ledger already holds this customer's opening as a DEBIT of exactly this magnitude,
   * written by the code before owner decision 6 (a non-production rehearsal). Nothing is
   * written: the ledger is never rewritten, and recording a debt beside that DEBIT would
   * count the debt twice. The importer counts it as attention (`docs/migration-opening-balance.md`).
   */
  | { readonly kind: 'PRIOR_DEBIT_OPENING'; readonly entry: WalletEntryRecord };

/**
 * Migration P2 — carries a legacy wallet balance into the ledger, once.
 *
 * ADDITIVE, never a set-balance: the entry is appended beside whatever the customer
 * already has, so a customer new to NEXA ends at the legacy balance and one who already
 * used NEXA ends at their NEXA balance plus the legacy one. There is no other mode.
 *
 * NEGATIVE balances (owner decision 6, 2026-10-07 — Mirza PR4): HELD FOR REVIEW. A
 * negative legacy balance writes NO ledger entry. It is recorded as a legacy wallet debt
 * (`legacy_wallet_debts`: exact magnitude, currency, legacy user id, source fingerprint, row
 * checksum, run), the customer's NEXA balance is left exactly as it is (0 for a new
 * customer), and the debt is NEVER collected — no top-up, purchase or ledger path reads it.
 * The owner decides per customer (ACKNOWLEDGED / WAIVED), and no decision moves money. The
 * code before this decision wrote a DEBIT without `canCover`; it no longer can. The debt is
 * keyed like the opening — one per customer and per legacy user id — so a rerun records no
 * second debt, and a figure that differs from the recorded one is refused like any changed
 * opening.
 *
 * IDEMPOTENT at the database: the reference is `legacy:opening:<telegram_user_id>`,
 * unique per tenant (`wallet_entries_tenant_reference_key`), backed by one opening per
 * customer (`wallet_entries_migration_opening_customer_key`). The reference IS this
 * command's idempotency key — derived, so it needs no idempotency row to survive a
 * crash. A rerun with a DIFFERENT figure is refused (`IDEMPOTENCY_PAYLOAD_MISMATCH`),
 * never silently answered with the first.
 *
 * Migration-only: no controller, no Telegram handler and no web page constructs or calls
 * this. The P7 importer is its only caller. (The Web Admin's debt list is a different
 * service, `LegacyWalletDebtService`, which records nothing and moves no money.)
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
    if (command.legacyBalanceMinor < 0n && !validProvenance(command.provenance)) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A negative legacy balance is recorded with the run and snapshot it was read from.',
      );
    }
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
        const debt =
          (await this.deps.debts.findByCustomer(scope, customerId, tx)) ??
          (await this.deps.debts.findByLegacyUserId(scope, telegramUserId, tx));

        if (command.legacyBalanceMinor < 0n) {
          return this.holdNegative(scope, actor, tx, {
            customerId,
            telegramUserId,
            magnitude,
            currency: command.currency,
            provenance: command.provenance,
            existing,
            debt,
          });
        }
        // A debt was recorded for this customer: a non-negative figure now is a changed one.
        if (debt !== null) throw payloadMismatch();

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
   * Owner decision 6: a negative legacy balance becomes a legacy debt, never a ledger entry.
   * Runs inside `post`'s transaction, under the wallet lock, after the customer checks.
   */
  private async holdNegative(
    scope: TenantContext,
    actor: ActorContext,
    tx: TransactionScope,
    input: {
      readonly customerId: UserId;
      readonly telegramUserId: string;
      readonly magnitude: bigint;
      readonly currency: CurrencyCode;
      readonly provenance: MigrationOpeningProvenance | undefined;
      readonly existing: WalletEntryRecord | null;
      readonly debt: LegacyWalletDebtRecord | null;
    },
  ): Promise<MigrationOpeningBalanceOutcome> {
    // The code before owner decision 6 wrote this opening as a DEBIT. The ledger is never
    // rewritten, and a debt beside that DEBIT would count it twice: nothing is written.
    if (input.existing !== null) {
      return {
        kind: 'PRIOR_DEBIT_OPENING',
        entry: this.sameOpening(
          input.existing,
          input.customerId,
          'DEBIT',
          input.magnitude,
          input.currency,
        ),
      };
    }
    if (input.debt !== null) {
      return {
        kind: 'DEBT_ALREADY_RECORDED',
        debt: sameDebt(
          input.debt,
          input.customerId,
          input.telegramUserId,
          input.magnitude,
          input.provenance,
        ),
      };
    }
    const provenance = input.provenance;
    if (provenance === undefined || input.currency !== LEGACY_WALLET_DEBT_CURRENCY) {
      // Unreachable from `post` (validated, and the selling currency checked), kept total.
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'A legacy debt is recorded in IRT with its provenance.',
      );
    }
    const { debt, inserted } = await this.deps.debts.insertIfAbsent(
      scope,
      {
        id: this.deps.ids.uuid(),
        customerId: input.customerId,
        legacyUserId: input.telegramUserId,
        amountMinor: input.magnitude,
        currency: LEGACY_WALLET_DEBT_CURRENCY,
        sourceFingerprint: provenance.sourceFingerprint,
        rowChecksum: provenance.rowChecksum,
        runId: provenance.runId,
        synthetic: provenance.synthetic,
        recordedAt: this.deps.clock.now(),
      },
      tx,
    );
    if (!inserted) {
      return {
        kind: 'DEBT_ALREADY_RECORDED',
        debt: sameDebt(debt, input.customerId, input.telegramUserId, input.magnitude, provenance),
      };
    }
    await this.deps.audit.record(
      scope,
      actor,
      {
        action: LEGACY_WALLET_DEBT_AUDIT_ACTIONS.recorded,
        entityType: 'LegacyWalletDebt',
        entityId: debt.id,
        before: null,
        after: {
          customerId: debt.customerId,
          state: debt.state,
          amountMinor: debt.amountMinor.toString(),
          currency: debt.currency,
          sourceFingerprint: debt.sourceFingerprint,
          runId: debt.runId,
          synthetic: debt.synthetic,
          ledgerEntry: null,
        },
        result: 'SUCCESS',
      },
      tx,
    );
    return { kind: 'DEBT_RECORDED', debt, amountMinor: debt.amountMinor };
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
    if (!same) throw payloadMismatch();
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

/** A changed figure on a rerun: refused, never answered with the first (the importer counts CONFLICT). */
function payloadMismatch(): Error {
  return errors.conflict(
    PLATFORM_ERROR_CODES.IDEMPOTENCY_PAYLOAD_MISMATCH,
    'This customer’s opening balance was already posted with a different figure.',
  );
}

/**
 * The debt already recorded, if it is the SAME one; otherwise a refusal. "Same" includes
 * the evidence class (PR3's review lesson on #232): a debt recorded from a SYNTHETIC source
 * is test data and is never taken for the real one — nor a real one for a fixture's — so a
 * mismatch is refused (counted CONFLICT by the importer) and nothing is written.
 */
function sameDebt(
  debt: LegacyWalletDebtRecord,
  customerId: UserId,
  telegramUserId: string,
  magnitude: bigint,
  provenance: MigrationOpeningProvenance | undefined,
): LegacyWalletDebtRecord {
  const same =
    debt.customerId === customerId &&
    debt.legacyUserId === telegramUserId &&
    debt.amountMinor === magnitude &&
    debt.currency === LEGACY_WALLET_DEBT_CURRENCY &&
    provenance !== undefined &&
    debt.synthetic === provenance.synthetic;
  if (!same) throw payloadMismatch();
  return debt;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

function validProvenance(p: MigrationOpeningProvenance | undefined): boolean {
  return (
    p !== undefined &&
    UUID.test(p.runId) &&
    SHA256.test(p.sourceFingerprint) &&
    SHA256.test(p.rowChecksum) &&
    typeof p.synthetic === 'boolean'
  );
}
