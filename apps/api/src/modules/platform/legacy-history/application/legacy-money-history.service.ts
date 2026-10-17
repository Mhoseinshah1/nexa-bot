import {
  COMMERCE_ERROR_CODES,
  errors,
  userIdSchema,
  type ActorContext,
  type LegacyMoneyHistoryResponse,
  type PermissionKey,
  type TenantContext,
} from '@nexa/contracts';
import type { PermissionGuard } from '../../access/application/permission-guard.js';
import type { LegacyHistoryCustomerReader } from './legacy-history-read.service.js';
import {
  amountWire,
  buildTenantMoneyReport,
  currencyOf,
  reconcile,
  summariseByStatus,
  summarisePayments,
  summariseWalletTransactions,
  summariseWheel,
  totalWire,
  type CustomerOpeningEvidence,
  type PaymentGroup,
  type StatusGroup,
  type TenantMoneyInput,
  type TenantMoneyReport,
  type WalletTransactionGroup,
  type WheelGroup,
} from './money-reconciliation.js';

/**
 * Mirza `.nxpkg` importer — «سوابق مالی میرزا»: a customer's Mirza money history beside the
 * opening figure the migration wrote, and the tenant-wide reconciliation report.
 *
 * READ ONLY. There is no write here and none behind it: the reader runs every statement in a
 * READ ONLY transaction. The opening figure is the snapshot `user.Balance`; the history is
 * evidence and is never added to a balance. Charged on `users.view`, the customer existing in
 * the tenant, then `legacy.history.view` (the history card's key, whose records carry every
 * amount summed here) AND `legacy.debts.view`: the response names the legacy wallet debt — its
 * amount and review state, and the opening figure and balances it shapes — which the history
 * card withholds without that key. Neither permission implies the other.
 */

export const LEGACY_MONEY_HISTORY_PERMISSION = 'legacy.history.view' satisfies PermissionKey;
const CUSTOMER_VIEW = 'users.view' satisfies PermissionKey;
/** The legacy wallet debt in the response: the same key the history card's debt count needs. */
export const LEGACY_MONEY_HISTORY_DEBTS_PERMISSION = 'legacy.debts.view' satisfies PermissionKey;

/** One customer's grouped money facts, as the reader returns them. */
export interface CustomerMoneyFacts {
  readonly payments: readonly PaymentGroup[];
  readonly walletTransactions: readonly WalletTransactionGroup[];
  readonly wheel: readonly WheelGroup[];
  readonly serviceOperations: readonly StatusGroup[];
  readonly referrals: {
    readonly asReferee: number;
    readonly asReferrer: number;
    readonly referrerGiftsPaid: number;
  };
  readonly discountsUsed: number;
  readonly opening: CustomerOpeningEvidence;
}

export interface LegacyMoneyHistoryReader {
  forCustomer(
    scope: TenantContext,
    customer: { readonly id: string; readonly telegramUserId: string },
  ): Promise<CustomerMoneyFacts>;
  forTenant(scope: TenantContext, statementTimeoutMs: number): Promise<TenantMoneyInput>;
}

export interface LegacyMoneyHistoryDeps {
  readonly reader: LegacyMoneyHistoryReader;
  readonly customers: LegacyHistoryCustomerReader;
  readonly guard: PermissionGuard;
}

export class LegacyMoneyHistoryService {
  constructor(private readonly deps: LegacyMoneyHistoryDeps) {}

  async forCustomer(
    scope: TenantContext,
    actor: ActorContext,
    id: string,
  ): Promise<LegacyMoneyHistoryResponse> {
    await this.deps.guard.check(scope, actor, CUSTOMER_VIEW);
    const parsed = userIdSchema.safeParse(id);
    if (!parsed.success) {
      throw errors.validation(
        COMMERCE_ERROR_CODES.COMMERCE_REQUEST_INVALID,
        'That is not a valid customer identifier.',
      );
    }
    const customer = await this.deps.customers.findById(scope, parsed.data);
    if (customer === null) {
      throw errors.notFound(COMMERCE_ERROR_CODES.CUSTOMER_NOT_FOUND, 'Unknown customer.');
    }
    await this.deps.guard.check(scope, actor, LEGACY_MONEY_HISTORY_PERMISSION);
    await this.deps.guard.check(scope, actor, LEGACY_MONEY_HISTORY_DEBTS_PERMISSION);
    const facts = await this.deps.reader.forCustomer(scope, {
      id: customer.id,
      telegramUserId: customer.telegramUserId,
    });
    return customerMoneyView(facts);
  }

  /**
   * The tenant-wide report, for the operator's CLI (it acts as the system, holding the
   * database credentials; there is no HTTP route because the scan outlasts a request).
   */
  async tenantReport(scope: TenantContext, statementTimeoutMs: number): Promise<TenantMoneyReport> {
    return buildTenantMoneyReport(await this.deps.reader.forTenant(scope, statementTimeoutMs));
  }
}

/** The wire view of one customer's facts. Pure. */
export function customerMoneyView(facts: CustomerMoneyFacts): LegacyMoneyHistoryResponse {
  const payments = summarisePayments(facts.payments);
  const wallet = summariseWalletTransactions(facts.walletTransactions);
  const wheel = summariseWheel(facts.wheel);
  const result = reconcile(facts.opening);
  const credit =
    facts.opening.openingCredits.length === 1 ? facts.opening.openingCredits[0] : undefined;
  const debt = facts.opening.debt;
  const creditCurrency = credit === undefined ? null : currencyOf(credit.currency);
  const debtCurrency = debt === null ? null : currencyOf(debt.currency);
  return {
    readOnly: true,
    addedToBalance: false,
    payments: {
      succeededByPurpose: payments.succeededByPurpose.map((row) => ({
        purpose: row.purpose,
        total: totalWire(row.total),
      })),
      excludedByOutcome: payments.excludedByOutcome.map((row) => ({
        outcome: row.outcome,
        total: totalWire(row.total),
      })),
    },
    walletTransactions: {
      moneyIn: totalWire(wallet.moneyIn),
      moneyOut: totalWire(wallet.moneyOut),
      noChange: wallet.noChange,
      unparsedAmounts: wallet.unparsedAmounts,
    },
    wheel: { spins: wheel.spins, prizesWon: totalWire(wheel.prizesWon) },
    referrals: { ...facts.referrals },
    discountsUsed: facts.discountsUsed,
    serviceOperations: summariseByStatus(facts.serviceOperations).map((row) => ({
      status: row.status,
      total: totalWire(row.total),
    })),
    opening: {
      credit:
        credit === undefined || creditCurrency === null
          ? null
          : amountWire({ amountMinor: credit.amountMinor, currency: creditCurrency }),
      debt:
        debt === null || debtCurrency === null
          ? null
          : {
              amount: amountWire({ amountMinor: debt.amountMinor, currency: debtCurrency }),
              state: debt.state,
            },
    },
    reconciliation: {
      status: result.status,
      openingFigure: result.openingFigure === null ? null : amountWire(result.openingFigure),
      snapshotBalance: result.snapshotBalance === null ? null : amountWire(result.snapshotBalance),
      historyClosingBalance:
        result.historyClosingBalance === null ? null : amountWire(result.historyClosingBalance),
      deltaSnapshotMinusHistory:
        result.deltaSnapshotMinusHistory === null
          ? null
          : amountWire(result.deltaSnapshotMinusHistory),
      historyVerdict: result.historyVerdict,
      difference: result.difference === null ? null : { ...result.difference },
      openingEqualsSnapshot: result.openingEqualsSnapshot,
    },
  };
}
