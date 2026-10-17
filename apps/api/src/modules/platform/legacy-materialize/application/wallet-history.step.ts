import {
  CURRENCY_CODES,
  WALLET_HISTORY_IMPORT_TEXT_MAX_LENGTH,
  type LedgerDirection,
  type WalletHistoryImportOrigin,
} from '@nexa/contracts';
import {
  abs,
  applyPlanned,
  at,
  bounded,
  customerOf,
  gap,
  matchPlanned,
  mirzaIdOf,
  mirzaInstant,
  parseMinor,
  sourceRefOf,
  text,
  write,
  type HistoryRecord,
  type MaterializeDeps,
  type Planned,
  type PlannedRepository,
  type PlannedStep,
  type PlannedWrite,
} from './materialize-support.js';
import type {
  ExactMatchRow,
  MaterializeContext,
  MaterializeStep,
  MaterializeStepOutcome,
} from './ports.js';

/**
 * Mirza wallet history into `wallet_history_imports` (plan §3, §5-3): the `wallet_transaction`
 * movement log and the wheel results.
 *
 * The table is a SISTER of the ledger and is never summed into a balance. The customer's
 * balance is `user.Balance`, already written as the one opening entry; these rows are what
 * Mirza logged on the way to it, and carrying them into `wallet_entries` would either change
 * that balance or need a compensating row — touching the money twice. A wheel prize is
 * already inside `user.Balance` (`prize_already_in_legacy_balance`), so it is history only.
 *
 * `direction` is read from Mirza's own arithmetic (balance after minus before); where that
 * does not decide it (no change, inconsistent, unreadable) it is null rather than guessed.
 * `amount_minor` is the magnitude and `signed_amount_minor` the figure as Mirza stored it,
 * so the sums the exact-match report compares are of magnitudes.
 */

export const WALLET_HISTORY_STEP = 'wallet-history';
export const WALLET_TX_SOURCE_REF_PREFIX = 'wallet-tx';
export const WHEEL_SOURCE_REF_PREFIX = 'wheel';

export interface WalletHistoryWrite extends PlannedWrite {
  readonly customerId: string;
  readonly origin: WalletHistoryImportOrigin;
  readonly occurredAt: Date;
  readonly direction: LedgerDirection | null;
  readonly signedAmountMinor: bigint;
  readonly currency: string;
  readonly rawKind: string | null;
  readonly note: string | null;
}

export function walletHistoryFingerprint(
  w: Omit<WalletHistoryWrite, 'fingerprint' | 'sourceRef'>,
): string {
  return [
    w.customerId,
    w.origin,
    w.occurredAt.toISOString(),
    w.direction ?? '-',
    w.signedAmountMinor.toString(),
    w.currency,
    w.rawKind ?? '-',
    w.note ?? '-',
  ].join('|');
}

const NOTE_MAX = WALLET_HISTORY_IMPORT_TEXT_MAX_LENGTH;

function build(
  sourceRef: string,
  fields: Omit<WalletHistoryWrite, 'fingerprint' | 'sourceRef'>,
): Planned<WalletHistoryWrite> {
  return write<WalletHistoryWrite>(
    { sourceRef, fingerprint: walletHistoryFingerprint(fields), ...fields },
    abs(fields.signedAmountMinor),
  );
}

export function planWalletTransaction(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
): Planned<WalletHistoryWrite> {
  const value = parseMinor(at(record.payload, 'amount', 'value_minor'));
  const sum = value === null ? 0n : abs(value);
  const id = mirzaIdOf(record, 'transaction_id');
  const sourceRef = id === null ? null : sourceRefOf(WALLET_TX_SOURCE_REF_PREFIX, id);
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE', sum);
  const customerId = customerOf(record, customers);
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED', sum);
  if (value === null) return gap('UNPARSEABLE_AMOUNT', 0n);
  const currency = text(at(record.payload, 'amount', 'currency'));
  if (currency === null || !(CURRENCY_CODES as readonly string[]).includes(currency)) {
    return gap('UNSUPPORTED_CURRENCY', sum);
  }
  const occurredAt =
    mirzaInstant(at(record.payload, 'created_at', 'unix')) ??
    mirzaInstant(at(record.payload, 'created_at', 'local'));
  if (occurredAt === null) return gap('UNPARSEABLE_TIME', sum);
  const verdict = text(at(record.payload, 'arithmetic'));
  const direction: LedgerDirection | null =
    verdict === 'ARITHMETIC_CREDIT' ? 'CREDIT' : verdict === 'ARITHMETIC_DEBIT' ? 'DEBIT' : null;
  return build(sourceRef, {
    customerId,
    origin: 'WALLET_TRANSACTION',
    occurredAt,
    direction,
    signedAmountMinor: value,
    currency,
    rawKind: bounded(at(record.payload, 'type', 'raw'), NOTE_MAX),
    note: bounded(record.payload['reason'], NOTE_MAX),
  });
}

export function planWheelSpin(
  record: HistoryRecord,
  customers: ReadonlyMap<string, string>,
): Planned<WalletHistoryWrite> {
  const value = parseMinor(at(record.payload, 'prize', 'amount_minor'));
  const sum = value === null ? 0n : abs(value);
  const id = mirzaIdOf(record);
  const sourceRef = id === null ? null : sourceRefOf(WHEEL_SOURCE_REF_PREFIX, id);
  if (sourceRef === null) return gap('SOURCE_ID_UNUSABLE', sum);
  const customerId = customerOf(record, customers);
  if (customerId === null) return gap('CUSTOMER_NOT_IMPORTED', sum);
  if (value === null) return gap('UNPARSEABLE_AMOUNT', 0n);
  const currency = text(at(record.payload, 'prize', 'currency'));
  if (currency === null || !(CURRENCY_CODES as readonly string[]).includes(currency)) {
    return gap('UNSUPPORTED_CURRENCY', sum);
  }
  const occurredAt = mirzaInstant(record.payload['spun_at']);
  if (occurredAt === null) return gap('UNPARSEABLE_TIME', sum);
  return build(sourceRef, {
    customerId,
    origin: 'WHEEL_SPIN',
    occurredAt,
    direction: value > 0n ? 'CREDIT' : null,
    signedAmountMinor: value,
    currency,
    rawKind: 'wheel',
    note: bounded(String(record.payload['dice_value_raw'] ?? ''), NOTE_MAX),
  });
}

export class WalletHistoryStep implements MaterializeStep {
  readonly name = WALLET_HISTORY_STEP;
  private readonly transactions: PlannedStep<WalletHistoryWrite>;
  private readonly wheel: PlannedStep<WalletHistoryWrite>;

  constructor(
    private readonly deps: MaterializeDeps,
    repository: PlannedRepository<WalletHistoryWrite>,
  ) {
    const planner =
      (one: typeof planWalletTransaction) =>
      async (
        records: readonly HistoryRecord[],
        ctx: MaterializeContext,
        tx: Parameters<PlannedStep<WalletHistoryWrite>['plan']>[2],
      ) => {
        const customers = await deps.records.customersByLegacyUser(
          ctx.scope,
          records.flatMap((r) => (r.legacyUserId === null ? [] : [r.legacyUserId])),
          tx,
        );
        return records.map((record) => one(record, customers));
      };
    this.transactions = {
      name: WALLET_HISTORY_STEP,
      recordType: 'wallet_transaction',
      repository,
      plan: planner(planWalletTransaction),
    };
    this.wheel = {
      name: WALLET_HISTORY_STEP,
      recordType: 'wheel_result',
      repository,
      plan: planner(planWheelSpin),
    };
  }

  async apply(ctx: MaterializeContext): Promise<MaterializeStepOutcome> {
    const first = await applyPlanned(this.deps, this.transactions, ctx);
    const second = await applyPlanned(this.deps, this.wheel, ctx);
    const skipped: Record<string, number> = { ...first.skipped };
    for (const [reason, n] of Object.entries(second.skipped)) {
      skipped[reason] = (skipped[reason] ?? 0) + n;
    }
    return {
      step: WALLET_HISTORY_STEP,
      written: first.written + second.written,
      alreadyPresent: first.alreadyPresent + second.alreadyPresent,
      diverged: first.diverged + second.diverged,
      skipped,
    };
  }

  async match(ctx: MaterializeContext): Promise<readonly ExactMatchRow[]> {
    return [
      await matchPlanned(this.deps, this.transactions, ctx, {
        mirzaTable: 'wallet_transaction',
        nexaTable: 'wallet_history_imports',
        hasAmount: true,
        nexaFilter: 'WALLET_TRANSACTION',
      }),
      await matchPlanned(this.deps, this.wheel, ctx, {
        mirzaTable: 'wheel_list',
        nexaTable: 'wallet_history_imports',
        hasAmount: true,
        nexaFilter: 'WHEEL_SPIN',
      }),
    ];
  }
}
