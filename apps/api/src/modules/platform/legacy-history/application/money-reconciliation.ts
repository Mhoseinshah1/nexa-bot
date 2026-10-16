import {
  CURRENCY_CODES,
  LEGACY_MONEY_PAYMENT_OUTCOMES,
  type CurrencyCode,
  type LegacyMoneyPaymentOutcome,
  type LegacyMoneyPaymentPurpose,
  type LegacyMoneyReconciliationStatus,
} from '@nexa/contracts';

/**
 * Mirza `.nxpkg` importer — the money history of a customer (or of the whole tenant), folded
 * from grouped aggregates, and set beside the opening figure the migration wrote.
 *
 * PURE: no I/O, no clock. Money is `bigint` minor units with an explicit currency; a float is
 * never formed. Nothing here can write: the result is a description of evidence. The rule it
 * states and never bends: the opening figure is Mirza's `user.Balance` snapshot; the history
 * is evidence about it and is never added to, netted against, or substituted for it.
 */

/** An amount as the converter writes it: a decimal integer string, optionally negative. */
export const LEGACY_AMOUNT_PATTERN = '^-?[0-9]{1,30}$';
const AMOUNT = new RegExp(LEGACY_AMOUNT_PATTERN, 'u');

export interface Amount {
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/** A known currency code, or null. */
export function currencyOf(value: string | null | undefined): CurrencyCode | null {
  return (CURRENCY_CODES as readonly string[]).includes(value ?? '')
    ? (value as CurrencyCode)
    : null;
}

/** An integer amount string as a bigint, or null when it is not one. Never a float. */
export function parseMinor(value: string | null | undefined): bigint | null {
  if (typeof value !== 'string' || !AMOUNT.test(value)) return null;
  return BigInt(value);
}

/** An amount with its currency, or null when either cannot be read. */
export function amountOf(
  minor: string | null | undefined,
  currency: string | null | undefined,
): Amount | null {
  const parsed = parseMinor(minor);
  const code = currencyOf(currency);
  return parsed === null || code === null ? null : { amountMinor: parsed, currency: code };
}

// --- totals --------------------------------------------------------------------------------

export interface MoneyTotal {
  readonly count: number;
  /** One per currency, in `CURRENCY_CODES` order. */
  readonly amounts: readonly Amount[];
  readonly unparsedAmounts: number;
  readonly unrecognisedCurrency: number;
}

/** One SQL group: `count` records of one currency, `sumMinor` over the readable ones. */
export interface AmountGroup {
  readonly currency: string | null;
  readonly count: number;
  readonly sumMinor: bigint;
  /** Records in the group whose amount was not an integer string. */
  readonly unparsed: number;
}

export const EMPTY_TOTAL: MoneyTotal = {
  count: 0,
  amounts: [],
  unparsedAmounts: 0,
  unrecognisedCurrency: 0,
};

/**
 * Folds groups into one total. A group of an unknown currency is counted (as
 * `unrecognisedCurrency`) and never summed: an amount without a currency is not money.
 */
export function totalOf(groups: readonly AmountGroup[]): MoneyTotal {
  let count = 0;
  let unparsed = 0;
  let foreign = 0;
  const sums = new Map<CurrencyCode, bigint>();
  for (const group of groups) {
    count += group.count;
    const code = currencyOf(group.currency);
    if (code === null) {
      foreign += group.count;
      continue;
    }
    unparsed += group.unparsed;
    sums.set(code, (sums.get(code) ?? 0n) + group.sumMinor);
  }
  return {
    count,
    amounts: CURRENCY_CODES.filter((code) => sums.has(code)).map((code) => ({
      amountMinor: sums.get(code) as bigint,
      currency: code,
    })),
    unparsedAmounts: unparsed,
    unrecognisedCurrency: foreign,
  };
}

// --- payments ------------------------------------------------------------------------------

/** One group of archived payments with the same codes. */
export interface PaymentGroup extends AmountGroup {
  readonly outcome: string | null;
  readonly method: string | null;
  readonly purpose: string | null;
}

/** The converter's purchase tags (`PURPOSE_VOCAB`, mirza_pro index.php:1807,2082,2624,3945). */
const PURCHASE_PURPOSES: ReadonlySet<string> = new Set([
  'BUY_SERVICE_AFTER_PAYMENT',
  'EXTEND_SERVICE',
  'EXTRA_VOLUME',
  'EXTRA_TIME',
]);
/** The converter's "any other tag": Mirza's DirectPayment top-up branch. */
const TOP_UP_PURPOSE = 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT';
const NOT_IN_SOURCE = 'NOT_IN_SOURCE';

/**
 * What a payment was for. The admin adjustments are told apart by METHOD whatever the purpose
 * says (the converter's own note: the top-up tag covers them too). A backup with no
 * `id_invoice` column states no purpose at all, and that is reported, never guessed.
 */
export function paymentPurposeOf(
  method: string | null,
  purpose: string | null,
): LegacyMoneyPaymentPurpose {
  if (method === 'ADMIN_CREDIT_ADJUSTMENT') return 'ADMIN_CREDIT';
  if (method === 'ADMIN_DEBIT_ADJUSTMENT') return 'ADMIN_DEBIT';
  if (purpose === null || purpose === NOT_IN_SOURCE) return 'PURPOSE_NOT_IN_SOURCE';
  if (PURCHASE_PURPOSES.has(purpose)) return 'SERVICE_PURCHASE';
  if (purpose === TOP_UP_PURPOSE) return 'WALLET_TOP_UP';
  return 'OTHER';
}

export function paymentOutcomeOf(outcome: string | null): LegacyMoneyPaymentOutcome {
  return (LEGACY_MONEY_PAYMENT_OUTCOMES as readonly string[]).includes(outcome ?? '')
    ? (outcome as LegacyMoneyPaymentOutcome)
    : 'UNKNOWN';
}

export interface PaymentSummary {
  readonly succeededByPurpose: readonly {
    readonly purpose: LegacyMoneyPaymentPurpose;
    readonly total: MoneyTotal;
  }[];
  readonly excludedByOutcome: readonly {
    readonly outcome: LegacyMoneyPaymentOutcome;
    readonly total: MoneyTotal;
  }[];
}

const PURPOSE_ORDER: readonly LegacyMoneyPaymentPurpose[] = [
  'WALLET_TOP_UP',
  'SERVICE_PURCHASE',
  'ADMIN_CREDIT',
  'ADMIN_DEBIT',
  'PURPOSE_NOT_IN_SOURCE',
  'OTHER',
];

/** Successful payments by purpose; every other outcome apart, in no successful total. */
export function summarisePayments(groups: readonly PaymentGroup[]): PaymentSummary {
  const succeeded = new Map<LegacyMoneyPaymentPurpose, PaymentGroup[]>();
  const excluded = new Map<LegacyMoneyPaymentOutcome, PaymentGroup[]>();
  for (const group of groups) {
    const outcome = paymentOutcomeOf(group.outcome);
    if (outcome === 'SUCCEEDED') {
      const purpose = paymentPurposeOf(group.method, group.purpose);
      succeeded.set(purpose, [...(succeeded.get(purpose) ?? []), group]);
    } else {
      excluded.set(outcome, [...(excluded.get(outcome) ?? []), group]);
    }
  }
  return {
    succeededByPurpose: PURPOSE_ORDER.filter((p) => succeeded.has(p)).map((purpose) => ({
      purpose,
      total: totalOf(succeeded.get(purpose) ?? []),
    })),
    excludedByOutcome: LEGACY_MONEY_PAYMENT_OUTCOMES.filter((o) => excluded.has(o)).map(
      (outcome) => ({ outcome, total: totalOf(excluded.get(outcome) ?? []) }),
    ),
  };
}

// --- wallet transactions, wheel, service operations ---------------------------------------

/** Mirza's wallet-transaction chain, per currency: credits, debits (as negative sums), zeros. */
export interface WalletTransactionGroup {
  readonly currency: string | null;
  readonly inCount: number;
  readonly inSumMinor: bigint;
  readonly outCount: number;
  /** The SIGNED sum of the debits (≤ 0), as stored. */
  readonly outSumMinor: bigint;
  readonly zeroCount: number;
  readonly unparsed: number;
}

export interface WalletTransactionSummary {
  readonly moneyIn: MoneyTotal;
  /** Magnitudes. */
  readonly moneyOut: MoneyTotal;
  readonly noChange: number;
  readonly unparsedAmounts: number;
}

export function summariseWalletTransactions(
  groups: readonly WalletTransactionGroup[],
): WalletTransactionSummary {
  return {
    moneyIn: totalOf(
      groups.map((g) => ({
        currency: g.currency,
        count: g.inCount,
        sumMinor: g.inSumMinor,
        unparsed: 0,
      })),
    ),
    moneyOut: totalOf(
      groups.map((g) => ({
        currency: g.currency,
        count: g.outCount,
        sumMinor: -g.outSumMinor,
        unparsed: 0,
      })),
    ),
    noChange: groups.reduce((n, g) => n + g.zeroCount, 0),
    unparsedAmounts: groups.reduce((n, g) => n + g.unparsed, 0),
  };
}

export interface WheelGroup extends AmountGroup {
  readonly won: boolean | null;
}

export function summariseWheel(groups: readonly WheelGroup[]): {
  readonly spins: number;
  readonly prizesWon: MoneyTotal;
} {
  return {
    spins: groups.reduce((n, g) => n + g.count, 0),
    prizesWon: totalOf(groups.filter((g) => g.won === true)),
  };
}

export interface StatusGroup extends AmountGroup {
  readonly status: string | null;
}

export function summariseByStatus(
  groups: readonly StatusGroup[],
): readonly { readonly status: string; readonly total: MoneyTotal }[] {
  const by = new Map<string, StatusGroup[]>();
  for (const group of groups) {
    const key = group.status ?? 'UNKNOWN';
    by.set(key, [...(by.get(key) ?? []), group]);
  }
  return [...by.keys()].sort().map((status) => ({ status, total: totalOf(by.get(status) ?? []) }));
}

// --- the reconciliation -----------------------------------------------------------------

/** Everything the migration wrote and the converter checked for ONE customer. */
export interface CustomerOpeningEvidence {
  /** The `MIGRATION_OPENING_BALANCE` CREDIT entries (one at most, by a unique index). */
  readonly openingCredits: readonly { readonly amountMinor: bigint; readonly currency: string }[];
  /** Opening-reason entries that are not CREDIT: must be zero. */
  readonly openingNonCredits: number;
  /** Every opening's reference is `legacy:opening:<the customer's Telegram id>`; null without one. */
  readonly openingReferenceMatches: boolean | null;
  /** The legacy debt (a positive amount) recorded instead of a negative opening. */
  readonly debt: {
    readonly amountMinor: bigint;
    readonly currency: string;
    readonly state: string;
  } | null;
  /** The converter's `wallet_history_check` record(s), raw strings as packaged. */
  readonly checks: readonly {
    readonly verdict: string | null;
    readonly snapshotMinor: string | null;
    readonly snapshotCurrency: string | null;
    readonly historyLastMinor: string | null;
    readonly historyLastCurrency: string | null;
    readonly deltaMinor: string | null;
  }[];
  readonly differences: readonly {
    readonly cause: string | null;
    readonly certainty: string | null;
  }[];
}

export interface Reconciliation {
  readonly status: LegacyMoneyReconciliationStatus;
  readonly openingFigure: Amount | null;
  readonly snapshotBalance: Amount | null;
  readonly historyClosingBalance: Amount | null;
  readonly deltaSnapshotMinusHistory: Amount | null;
  readonly historyVerdict: string | null;
  readonly difference: { readonly cause: string | null; readonly certainty: string | null } | null;
  readonly openingEqualsSnapshot: boolean | null;
}

const VERDICT_MATCHES = 'MATCHES_SNAPSHOT';
const VERDICT_DIFFERS = 'DIFFERS_FROM_SNAPSHOT';

/**
 * The opening figure the migration wrote: credit − debt, or zero when neither exists (in the
 * fallback currency). Undefined when the opening itself is malformed; null when there is
 * nothing to state a currency from.
 */
function openingFigureOf(
  evidence: CustomerOpeningEvidence,
  fallback: CurrencyCode | null,
): Amount | null | undefined {
  const credits = evidence.openingCredits;
  if (credits.length > 1 || evidence.openingNonCredits > 0) return undefined;
  if (evidence.openingReferenceMatches === false) return undefined;
  if (credits.length === 1 && evidence.debt !== null) return undefined;
  const credit = credits[0];
  if (credit !== undefined) {
    const code = currencyOf(credit.currency);
    if (code === null || credit.amountMinor <= 0n) return undefined;
    return { amountMinor: credit.amountMinor, currency: code };
  }
  if (evidence.debt !== null) {
    const code = currencyOf(evidence.debt.currency);
    if (code === null || evidence.debt.amountMinor <= 0n) return undefined;
    return { amountMinor: -evidence.debt.amountMinor, currency: code };
  }
  return fallback === null ? null : { amountMinor: 0n, currency: fallback };
}

/** How the archived history relates to the opening figure, for one customer. */
export function reconcile(evidence: CustomerOpeningEvidence): Reconciliation {
  const check = evidence.checks.length === 1 ? evidence.checks[0] : undefined;
  const snapshot =
    check === undefined ? null : amountOf(check.snapshotMinor, check.snapshotCurrency);
  const closing =
    check === undefined ? null : amountOf(check.historyLastMinor, check.historyLastCurrency);
  const deltaMinor = check === undefined ? null : parseMinor(check.deltaMinor);
  const difference = evidence.differences.length === 1 ? (evidence.differences[0] ?? null) : null;
  const opening = openingFigureOf(evidence, snapshot?.currency ?? null);
  const base = {
    openingFigure: opening ?? null,
    snapshotBalance: snapshot,
    historyClosingBalance: closing,
    deltaSnapshotMinusHistory:
      deltaMinor === null || snapshot === null
        ? null
        : { amountMinor: deltaMinor, currency: snapshot.currency },
    historyVerdict: check?.verdict ?? null,
    difference,
    openingEqualsSnapshot: null,
  };
  const out = (
    status: LegacyMoneyReconciliationStatus,
    equal: boolean | null = null,
  ): Reconciliation => ({ ...base, status, openingEqualsSnapshot: equal });

  if (opening === undefined) return out('OPENING_INVALID');
  if (evidence.checks.length > 1) return out('AMBIGUOUS_EVIDENCE');
  if (check === undefined) {
    return opening === null ? out('NO_OPENING_FIGURE') : out('NO_WALLET_HISTORY');
  }
  if (snapshot === null || opening === null) return out('UNREADABLE_EVIDENCE');
  const equal =
    opening.currency === snapshot.currency && opening.amountMinor === snapshot.amountMinor;
  if (!equal) return out('OPENING_DIFFERS_FROM_SNAPSHOT', false);
  if (check.verdict === VERDICT_MATCHES) return out('RECONCILED', true);
  if (check.verdict === VERDICT_DIFFERS) return out('HISTORY_DIFFERS_SNAPSHOT_KEPT', true);
  return out('UNREADABLE_EVIDENCE', true);
}

// --- the tenant-wide report ---------------------------------------------------------------

/** The import's own stated figures (its dry-run report), for the totals check. */
export interface StatedImportTotals {
  readonly walletCustomers: number | null;
  /** The wallets' total after the import and before it: the import wrote the difference. */
  readonly walletAfterTotalMinor: string | null;
  readonly walletBeforeTotalMinor: string | null;
  readonly walletCurrency: string | null;
  readonly debtCount: number | null;
  readonly debtTotalMinor: string | null;
  readonly debtCurrency: string | null;
}

export interface TenantMoneyInput {
  /** One per customer with an opening, a debt or a wallet-history check. */
  readonly customers: readonly CustomerOpeningEvidence[];
  /** `wallet_history_check` records linked to no customer. */
  readonly unlinkedChecks: number;
  /** The COMPLETED imports' stated totals (normally one). */
  readonly stated: readonly StatedImportTotals[];
  readonly payments: readonly PaymentGroup[];
  readonly walletTransactions: readonly WalletTransactionGroup[];
  readonly wheel: readonly WheelGroup[];
  readonly serviceOperations: readonly StatusGroup[];
  readonly referrals: { readonly records: number; readonly referrerGiftsPaid: number };
  readonly discountsUsed: number;
  /** Ledger entries by reason (counts only): shows the opening is the ledger's only legacy writer. */
  readonly ledgerReasons: readonly { readonly reason: string; readonly count: number }[];
}

export interface TenantMoneyReport {
  readonly opening: {
    readonly credits: MoneyTotal;
    readonly debts: MoneyTotal;
    readonly debtsByState: readonly { readonly state: string; readonly count: number }[];
    /** The ledger's opening total equals the import's stated total (and so does the count). */
    readonly matchesImportStatement: boolean | null;
    readonly debtsMatchImportStatement: boolean | null;
  };
  /** Customers per reconciliation status. */
  readonly byStatus: readonly {
    readonly status: LegacyMoneyReconciliationStatus;
    readonly customers: number;
  }[];
  /** Customers with a wallet-history check, per converter verdict. */
  readonly byVerdict: readonly { readonly verdict: string; readonly customers: number }[];
  /** Of the customers with a check: how many openings equal the snapshot, how many do not. */
  readonly snapshotCheck: {
    readonly checked: number;
    readonly openingEqualsSnapshot: number;
    readonly notProvenEqual: number;
    readonly unlinkedChecks: number;
  };
  readonly payments: PaymentSummary;
  readonly walletTransactions: WalletTransactionSummary;
  readonly wheel: { readonly spins: number; readonly prizesWon: MoneyTotal };
  readonly serviceOperations: readonly { readonly status: string; readonly total: MoneyTotal }[];
  readonly referrals: { readonly records: number; readonly referrerGiftsPaid: number };
  readonly discountsUsed: number;
  readonly ledgerReasons: readonly { readonly reason: string; readonly count: number }[];
  /** The one-line answer: every opening credit is the snapshot balance, as far as evidenced. */
  readonly statement: {
    readonly everyOpeningEqualsSnapshot: boolean;
    readonly basis: 'PER_CUSTOMER_CHECK_AND_IMPORT_TOTALS' | 'PER_CUSTOMER_CHECK_ONLY';
  };
}

/** After − before, as a decimal string; null when either cannot be read. */
function writtenByImport(after: string | null, before: string | null): string | null {
  const a = parseMinor(after);
  const b = parseMinor(before);
  return a === null || b === null ? null : (a - b).toString();
}

function statedEquals(
  total: MoneyTotal,
  minor: string | null,
  currency: string | null,
  count: number | null,
): boolean | null {
  if (minor === null || currency === null || count === null) return null;
  const expected = amountOf(minor, currency);
  if (expected === null) return false;
  const actual = total.amounts;
  if (expected.amountMinor === 0n && actual.length === 0) return total.count === count;
  return (
    total.count === count &&
    total.unparsedAmounts === 0 &&
    total.unrecognisedCurrency === 0 &&
    actual.length === 1 &&
    actual[0]?.currency === expected.currency &&
    actual[0].amountMinor === expected.amountMinor
  );
}

/** The tenant-wide report: aggregates and counts only, never a customer. */
export function buildTenantMoneyReport(input: TenantMoneyInput): TenantMoneyReport {
  const statuses = new Map<LegacyMoneyReconciliationStatus, number>();
  const verdicts = new Map<string, number>();
  const creditGroups: AmountGroup[] = [];
  const debtGroups: AmountGroup[] = [];
  const debtStates = new Map<string, number>();
  let checked = 0;
  let equal = 0;
  let differs = 0;
  for (const customer of input.customers) {
    const result = reconcile(customer);
    statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
    for (const credit of customer.openingCredits) {
      creditGroups.push({
        currency: credit.currency,
        count: 1,
        sumMinor: credit.amountMinor,
        unparsed: 0,
      });
    }
    if (customer.debt !== null) {
      debtGroups.push({
        currency: customer.debt.currency,
        count: 1,
        sumMinor: customer.debt.amountMinor,
        unparsed: 0,
      });
      debtStates.set(customer.debt.state, (debtStates.get(customer.debt.state) ?? 0) + 1);
    }
    if (customer.checks.length > 0) {
      checked += 1;
      for (const check of customer.checks) {
        const verdict = check.verdict ?? 'NONE';
        verdicts.set(verdict, (verdicts.get(verdict) ?? 0) + 1);
      }
      if (result.openingEqualsSnapshot === true) equal += 1;
      else differs += 1;
    }
  }
  const credits = totalOf(creditGroups);
  const debts = totalOf(debtGroups);
  const stated = input.stated.length === 1 ? input.stated[0] : undefined;
  const matches =
    stated === undefined
      ? null
      : statedEquals(
          credits,
          writtenByImport(stated.walletAfterTotalMinor, stated.walletBeforeTotalMinor),
          stated.walletCurrency,
          stated.walletCustomers,
        );
  const debtsMatch =
    stated === undefined
      ? null
      : statedEquals(debts, stated.debtTotalMinor, stated.debtCurrency, stated.debtCount);
  const perCustomerClean =
    differs === 0 &&
    input.unlinkedChecks === 0 &&
    (statuses.get('OPENING_INVALID') ?? 0) === 0 &&
    (statuses.get('OPENING_DIFFERS_FROM_SNAPSHOT') ?? 0) === 0;
  return {
    opening: {
      credits,
      debts,
      debtsByState: [...debtStates.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([state, count]) => ({ state, count })),
      matchesImportStatement: matches,
      debtsMatchImportStatement: debtsMatch,
    },
    byStatus: [...statuses.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([status, customers]) => ({ status, customers })),
    byVerdict: [...verdicts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([verdict, customers]) => ({ verdict, customers })),
    snapshotCheck: {
      checked,
      openingEqualsSnapshot: equal,
      notProvenEqual: differs,
      unlinkedChecks: input.unlinkedChecks,
    },
    payments: summarisePayments(input.payments),
    walletTransactions: summariseWalletTransactions(input.walletTransactions),
    wheel: summariseWheel(input.wheel),
    serviceOperations: summariseByStatus(input.serviceOperations),
    referrals: input.referrals,
    discountsUsed: input.discountsUsed,
    ledgerReasons: [...input.ledgerReasons].sort((a, b) => a.reason.localeCompare(b.reason)),
    statement: {
      everyOpeningEqualsSnapshot: perCustomerClean && matches !== false && debtsMatch !== false,
      basis:
        matches === null || debtsMatch === null
          ? 'PER_CUSTOMER_CHECK_ONLY'
          : 'PER_CUSTOMER_CHECK_AND_IMPORT_TOTALS',
    },
  };
}

// --- wire --------------------------------------------------------------------------------

export function amountWire(value: Amount): { amountMinor: string; currency: CurrencyCode } {
  return { amountMinor: value.amountMinor.toString(), currency: value.currency };
}

export function totalWire(total: MoneyTotal): {
  count: number;
  amounts: { amountMinor: string; currency: CurrencyCode }[];
  unparsedAmounts: number;
  unrecognisedCurrency: number;
} {
  return {
    count: total.count,
    amounts: total.amounts.map(amountWire),
    unparsedAmounts: total.unparsedAmounts,
    unrecognisedCurrency: total.unrecognisedCurrency,
  };
}
