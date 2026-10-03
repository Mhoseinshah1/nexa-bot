import {
  WALLET_REPORT_GROUP_OF,
  WALLET_REPORT_GROUPS,
  type CurrencyCode,
  type FinancialLines,
  type ReportPaymentKind,
  type PaymentMethod,
  type WalletReportGroup,
} from '@nexa/contracts';
import type {
  CurrencyAmount,
  FinancialCashRow,
  FinancialLedgerRow,
  FinancialRefundRow,
  FinancialSalesRow,
} from './ports.js';

/**
 * Phase E2 — the financial statement, as pure arithmetic over grouped rows
 * (`docs/financial-reports.md`).
 *
 * The repository returns ONE kind of fact per statement, each on its own timestamp and
 * already grouped by bucket and currency. This file only files those groups into lines.
 * The three sections are never added together, and that is where double counting is
 * prevented, by construction:
 *
 * - **Sales** read orders only. A top-up is not an order, so it cannot be a sale; a wallet
 *   purchase is an order, so it is a sale exactly once.
 * - **Cash** reads non-wallet CONFIRMED payments only (plus receipt credits). A wallet
 *   purchase moves no money from outside, so it is never cash; the top-up that funded it
 *   was, once, when it arrived.
 * - **Wallet** reads the ledger only: the top-up as a credit, the purchase as a debit.
 *
 * So "top-up then wallet purchase" is one cash receipt, one sale, and a liability that rose
 * and fell back — and no line anywhere holds the amount twice.
 */

/** Signed by the ledger rule: CREDIT adds, DEBIT subtracts. */
function signed(row: Pick<FinancialLedgerRow, 'direction' | 'amount'>): bigint {
  return row.direction === 'CREDIT' ? row.amount : -row.amount;
}

interface MutableLines {
  salesCount: number;
  grossSales: bigint;
  discounts: bigint;
  sales: bigint;
  refundCount: number;
  refunds: bigint;
  refundsToWallet: bigint;
  refundsPaidOut: bigint;
  externalPayments: number;
  principalReceived: bigint;
  customerFees: bigint;
  customerPaid: bigint;
  receiptCredits: bigint;
  walletTopups: bigint;
  walletSpending: bigint;
  cashbackNet: bigint;
  commissionNet: bigint;
  gifts: bigint;
}

function emptyLines(): MutableLines {
  return {
    salesCount: 0,
    grossSales: 0n,
    discounts: 0n,
    sales: 0n,
    refundCount: 0,
    refunds: 0n,
    refundsToWallet: 0n,
    refundsPaidOut: 0n,
    externalPayments: 0,
    principalReceived: 0n,
    customerFees: 0n,
    customerPaid: 0n,
    receiptCredits: 0n,
    walletTopups: 0n,
    walletSpending: 0n,
    cashbackNet: 0n,
    commissionNet: 0n,
    gifts: 0n,
  };
}

/** The bigint form of one currency's lines, before the wire turns money into strings. */
export interface StatementLines extends Readonly<MutableLines> {
  readonly currency: CurrencyCode;
  readonly netSales: bigint;
}

export interface StatementInput {
  /** The indexes of the buckets that have begun; the others are not yet anything. */
  readonly begunBuckets: readonly number[];
  readonly sales: readonly FinancialSalesRow[];
  readonly refunds: readonly FinancialRefundRow[];
  readonly cash: readonly FinancialCashRow[];
  readonly ledger: readonly FinancialLedgerRow[];
  readonly opening: readonly CurrencyAmount[];
}

export interface CashRouteTotals {
  readonly method: PaymentMethod;
  readonly provider: string | null;
  readonly kind: ReportPaymentKind;
  readonly currency: CurrencyCode;
  readonly payments: number;
  readonly principal: bigint;
  readonly customerFees: bigint;
  readonly customerPaid: bigint;
}

export interface WalletLiability {
  readonly currency: CurrencyCode;
  readonly opening: bigint;
  readonly closing: bigint;
  readonly movements: readonly { readonly group: WalletReportGroup; readonly amount: bigint }[];
}

export interface Statement {
  /** Bucket index → its lines per currency (only currencies with activity). */
  readonly buckets: ReadonlyMap<number, readonly StatementLines[]>;
  /** The period's lines per currency: Σ of the buckets, exactly. */
  readonly totals: readonly StatementLines[];
  readonly cashByRoute: readonly CashRouteTotals[];
  readonly wallet: readonly WalletLiability[];
}

/** Files the grouped rows into the statement. Pure: same rows, same statement. */
export function financialStatement(input: StatementInput): Statement {
  const begun = new Set(input.begunBuckets);
  const cells = new Map<number, Map<CurrencyCode, MutableLines>>();
  const cell = (bucket: number, currency: CurrencyCode): MutableLines | null => {
    // A row outside a begun bucket cannot occur (the window is the begun buckets' union);
    // refusing it here keeps a future caller from smuggling one into the totals.
    if (!begun.has(bucket)) return null;
    let byCurrency = cells.get(bucket);
    if (byCurrency === undefined) {
      byCurrency = new Map();
      cells.set(bucket, byCurrency);
    }
    let lines = byCurrency.get(currency);
    if (lines === undefined) {
      lines = emptyLines();
      byCurrency.set(currency, lines);
    }
    return lines;
  };

  for (const row of input.sales) {
    const lines = cell(row.bucket, row.currency);
    if (lines === null) continue;
    lines.salesCount += row.count;
    lines.grossSales += row.gross;
    lines.discounts += row.discount;
    lines.sales += row.total;
  }
  for (const row of input.refunds) {
    const lines = cell(row.bucket, row.currency);
    if (lines === null) continue;
    lines.refundCount += row.count;
    lines.refunds += row.amount;
    if (row.channel === 'WALLET_CREDIT') lines.refundsToWallet += row.amount;
    else lines.refundsPaidOut += row.amount;
  }
  for (const row of input.cash) {
    const lines = cell(row.bucket, row.currency);
    if (lines === null) continue;
    lines.externalPayments += row.count;
    lines.principalReceived += row.principal;
    lines.customerFees += row.fee;
    lines.customerPaid += row.payable;
  }
  for (const row of input.ledger) {
    const lines = cell(row.bucket, row.currency);
    if (lines === null) continue;
    switch (WALLET_REPORT_GROUP_OF[row.reason]) {
      case 'TOPUP':
        lines.walletTopups += signed(row);
        break;
      case 'RECEIPT_CREDIT':
        lines.receiptCredits += signed(row);
        break;
      case 'SPENDING':
        // A positive magnitude: what customers spent from their wallets.
        lines.walletSpending -= signed(row);
        break;
      case 'CASHBACK':
      case 'CASHBACK_REVERSAL':
        lines.cashbackNet += signed(row);
        break;
      case 'REFERRAL_COMMISSION':
      case 'REFERRAL_COMMISSION_REVERSAL':
        lines.commissionNet += signed(row);
        break;
      case 'GIFT':
        lines.gifts += signed(row);
        break;
      default:
        // REFUND, ADMINISTRATIVE, TRANSFER and OTHER are on the wallet section only. A
        // refund to a wallet is already the sales section's refund line; repeating it
        // here as income or spending would count it twice.
        break;
    }
  }

  const finish = (currency: CurrencyCode, lines: MutableLines): StatementLines => ({
    currency,
    ...lines,
    netSales: lines.sales - lines.refunds,
  });

  const buckets = new Map<number, StatementLines[]>();
  const totals = new Map<CurrencyCode, MutableLines>();
  for (const bucket of [...cells.keys()].sort((a, b) => a - b)) {
    const byCurrency = cells.get(bucket) as Map<CurrencyCode, MutableLines>;
    const out: StatementLines[] = [];
    for (const currency of [...byCurrency.keys()].sort()) {
      const lines = byCurrency.get(currency) as MutableLines;
      out.push(finish(currency, lines));
      const total = totals.get(currency) ?? emptyLines();
      addInto(total, lines);
      totals.set(currency, total);
    }
    buckets.set(bucket, out);
  }

  return {
    buckets,
    totals: [...totals.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, lines]) => finish(currency, lines)),
    cashByRoute: cashByRoute(input.cash, begun),
    wallet: walletLiability(input.ledger, input.opening, begun),
  };
}

function addInto(into: MutableLines, from: MutableLines): void {
  into.salesCount += from.salesCount;
  into.grossSales += from.grossSales;
  into.discounts += from.discounts;
  into.sales += from.sales;
  into.refundCount += from.refundCount;
  into.refunds += from.refunds;
  into.refundsToWallet += from.refundsToWallet;
  into.refundsPaidOut += from.refundsPaidOut;
  into.externalPayments += from.externalPayments;
  into.principalReceived += from.principalReceived;
  into.customerFees += from.customerFees;
  into.customerPaid += from.customerPaid;
  into.receiptCredits += from.receiptCredits;
  into.walletTopups += from.walletTopups;
  into.walletSpending += from.walletSpending;
  into.cashbackNet += from.cashbackNet;
  into.commissionNet += from.commissionNet;
  into.gifts += from.gifts;
}

function cashByRoute(
  rows: readonly FinancialCashRow[],
  begun: ReadonlySet<number>,
): CashRouteTotals[] {
  const routes = new Map<string, CashRouteTotals>();
  for (const row of rows) {
    if (!begun.has(row.bucket)) continue;
    const key = `${row.method}|${row.provider ?? ''}|${row.kind}|${row.currency}`;
    const found = routes.get(key);
    routes.set(key, {
      method: row.method,
      provider: row.provider,
      kind: row.kind,
      currency: row.currency,
      payments: (found?.payments ?? 0) + row.count,
      principal: (found?.principal ?? 0n) + row.principal,
      customerFees: (found?.customerFees ?? 0n) + row.fee,
      customerPaid: (found?.customerPaid ?? 0n) + row.payable,
    });
  }
  return [...routes.values()].sort(
    (a, b) =>
      a.method.localeCompare(b.method) ||
      (a.provider ?? '').localeCompare(b.provider ?? '') ||
      a.kind.localeCompare(b.kind) ||
      a.currency.localeCompare(b.currency),
  );
}

/**
 * The liability: opening + Σ movements = closing, per currency. Closing is DERIVED, so the
 * identity holds by construction in the response; the integration suite checks it against
 * an independent read of the balance.
 */
function walletLiability(
  ledger: readonly FinancialLedgerRow[],
  opening: readonly CurrencyAmount[],
  begun: ReadonlySet<number>,
): WalletLiability[] {
  const currencies = new Map<CurrencyCode, Map<WalletReportGroup, bigint>>();
  const groupsOf = (currency: CurrencyCode) => {
    let groups = currencies.get(currency);
    if (groups === undefined) {
      groups = new Map();
      currencies.set(currency, groups);
    }
    return groups;
  };
  for (const row of opening) groupsOf(row.currency);
  for (const row of ledger) {
    if (!begun.has(row.bucket)) continue;
    const groups = groupsOf(row.currency);
    const group = WALLET_REPORT_GROUP_OF[row.reason];
    groups.set(group, (groups.get(group) ?? 0n) + signed(row));
  }
  return [...currencies.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, groups]) => {
      const start = opening.find((row) => row.currency === currency)?.amount ?? 0n;
      const movements = WALLET_REPORT_GROUPS.filter((group) => groups.has(group)).map((group) => ({
        group,
        amount: groups.get(group) as bigint,
      }));
      return {
        currency,
        opening: start,
        closing: movements.reduce((sum, m) => sum + m.amount, start),
        movements,
      };
    });
}

/** The wire form of one currency's lines: money as integer strings. */
export function linesOnWire(lines: StatementLines): FinancialLines {
  return {
    currency: lines.currency,
    salesCount: lines.salesCount,
    grossSales: lines.grossSales.toString(),
    discounts: lines.discounts.toString(),
    sales: lines.sales.toString(),
    refundCount: lines.refundCount,
    refunds: lines.refunds.toString(),
    refundsToWallet: lines.refundsToWallet.toString(),
    refundsPaidOut: lines.refundsPaidOut.toString(),
    netSales: lines.netSales.toString(),
    externalPayments: lines.externalPayments,
    principalReceived: lines.principalReceived.toString(),
    customerFees: lines.customerFees.toString(),
    customerPaid: lines.customerPaid.toString(),
    receiptCredits: lines.receiptCredits.toString(),
    walletTopups: lines.walletTopups.toString(),
    walletSpending: lines.walletSpending.toString(),
    cashbackNet: lines.cashbackNet.toString(),
    commissionNet: lines.commissionNet.toString(),
    gifts: lines.gifts.toString(),
  };
}
