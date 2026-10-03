import { describe, expect, it } from 'vitest';
import { financialGranularityFor, LEDGER_REASONS, WALLET_REPORT_GROUP_OF } from '@nexa/contracts';
import { financialStatement } from '../../apps/api/src/modules/commerce/reporting/application/financial-statement';
import type { FinancialLedgerRow } from '../../apps/api/src/modules/commerce/reporting/application/ports';

/**
 * Phase E2 — the financial statement's filing rules, pure (`docs/financial-reports.md`).
 * The integration suite proves the SQL; this proves the arithmetic on the grouped rows.
 */

const ledger = (
  bucket: number,
  reason: FinancialLedgerRow['reason'],
  direction: 'CREDIT' | 'DEBIT',
  amount: bigint,
): FinancialLedgerRow => ({ bucket, currency: 'IRT', reason, direction, count: 1, amount });

describe('financialStatement', () => {
  it('files a top-up and the wallet purchase it funds into different sections, once each', () => {
    const s = financialStatement({
      begunBuckets: [0],
      sales: [{ bucket: 0, currency: 'IRT', count: 1, gross: 300n, discount: 0n, total: 300n }],
      refunds: [],
      cash: [
        {
          bucket: 0,
          currency: 'IRT',
          method: 'MANUAL_TRANSFER',
          provider: 'MANUAL_TRANSFER',
          kind: 'TOPUP',
          count: 1,
          principal: 500n,
          fee: 0n,
          payable: 500n,
        },
      ],
      ledger: [ledger(0, 'TOPUP_RECEIPT', 'CREDIT', 500n), ledger(0, 'PURCHASE', 'DEBIT', 300n)],
      opening: [],
    });
    const [total] = s.totals;
    expect(total).toMatchObject({
      sales: 300n,
      customerPaid: 500n,
      walletTopups: 500n,
      walletSpending: 300n,
    });
    expect(s.wallet[0]).toMatchObject({ opening: 0n, closing: 200n });
  });

  it('keeps a wallet refund out of every income line; the sales refund line holds it', () => {
    const s = financialStatement({
      begunBuckets: [0],
      sales: [],
      refunds: [{ bucket: 0, currency: 'IRT', channel: 'WALLET_CREDIT', count: 1, amount: 200n }],
      cash: [],
      ledger: [ledger(0, 'REFUND', 'CREDIT', 200n)],
      opening: [{ currency: 'IRT', amount: 10n }],
    });
    const [total] = s.totals;
    expect(total).toMatchObject({
      refunds: 200n,
      refundsToWallet: 200n,
      netSales: -200n,
      walletTopups: 0n,
      receiptCredits: 0n,
      cashbackNet: 0n,
      gifts: 0n,
    });
    expect(s.wallet[0]?.movements).toEqual([{ group: 'REFUND', amount: 200n }]);
    expect(s.wallet[0]?.closing).toBe(210n);
  });

  it('nets reversals and leaves a transfer pair at zero', () => {
    const s = financialStatement({
      begunBuckets: [0, 1],
      sales: [],
      refunds: [],
      cash: [],
      ledger: [
        ledger(0, 'CASHBACK_PURCHASE', 'CREDIT', 100n),
        ledger(1, 'CASHBACK_REVERSAL', 'DEBIT', 40n),
        ledger(0, 'REFERRAL_COMMISSION', 'CREDIT', 50n),
        ledger(1, 'REFERRAL_COMMISSION_REVERSAL', 'DEBIT', 50n),
        ledger(1, 'ACCOUNT_TRANSFER_OUT', 'DEBIT', 70n),
        ledger(1, 'ACCOUNT_TRANSFER_IN', 'CREDIT', 70n),
      ],
      opening: [],
    });
    expect(s.totals[0]).toMatchObject({ cashbackNet: 60n, commissionNet: 0n, walletSpending: 0n });
    expect(s.wallet[0]?.movements.find((m) => m.group === 'TRANSFER')?.amount).toBe(0n);
  });

  it('never files a transfer as spending, even one half of the pair alone', () => {
    const s = financialStatement({
      begunBuckets: [0],
      sales: [],
      refunds: [],
      cash: [],
      ledger: [ledger(0, 'ACCOUNT_TRANSFER_OUT', 'DEBIT', 70n)],
      opening: [{ currency: 'IRT', amount: 70n }],
    });
    expect(s.totals[0]).toMatchObject({ walletSpending: 0n, walletTopups: 0n, gifts: 0n });
    expect(s.wallet[0]).toMatchObject({ closing: 0n });
  });

  it('files a legacy opening balance on the wallet only, as its own movement, either sign', () => {
    // Migration P2: an inherited liability. Never a top-up, spending, a gift or cash.
    const s = financialStatement({
      begunBuckets: [0],
      sales: [],
      refunds: [],
      cash: [],
      ledger: [
        ledger(0, 'MIGRATION_OPENING_BALANCE', 'CREDIT', 900n),
        ledger(0, 'MIGRATION_OPENING_BALANCE', 'DEBIT', 300n),
      ],
      opening: [{ currency: 'IRT', amount: 50n }],
    });
    expect(s.totals[0]).toMatchObject({
      sales: 0n,
      walletTopups: 0n,
      walletSpending: 0n,
      gifts: 0n,
      cashbackNet: 0n,
      commissionNet: 0n,
      receiptCredits: 0n,
      principalReceived: 0n,
    });
    expect(s.wallet[0]).toEqual({
      currency: 'IRT',
      opening: 50n,
      closing: 650n,
      movements: [{ group: 'OPENING_BALANCE', amount: 600n }],
    });
  });

  it('ignores a row in a bucket that has not begun, in the buckets and the totals alike', () => {
    const s = financialStatement({
      begunBuckets: [0],
      sales: [
        { bucket: 0, currency: 'IRT', count: 1, gross: 1n, discount: 0n, total: 1n },
        { bucket: 1, currency: 'IRT', count: 1, gross: 9n, discount: 0n, total: 9n },
      ],
      refunds: [],
      cash: [],
      ledger: [],
      opening: [],
    });
    expect([...s.buckets.keys()]).toEqual([0]);
    expect(s.totals[0]?.sales).toBe(1n);
  });

  it('keeps currencies apart', () => {
    const s = financialStatement({
      begunBuckets: [0],
      sales: [
        { bucket: 0, currency: 'IRT', count: 1, gross: 5n, discount: 0n, total: 5n },
        { bucket: 0, currency: 'USD', count: 1, gross: 7n, discount: 0n, total: 7n },
      ],
      refunds: [],
      cash: [],
      ledger: [],
      opening: [],
    });
    expect(s.totals.map((t) => [t.currency, t.sales])).toEqual([
      ['IRT', 5n],
      ['USD', 7n],
    ]);
  });

  it('files every ledger reason somewhere without throwing', () => {
    const rows = LEDGER_REASONS.map((reason) => ledger(0, reason, 'CREDIT', 1n));
    const s = financialStatement({
      begunBuckets: [0],
      sales: [],
      refunds: [],
      cash: [],
      ledger: rows,
      opening: [],
    });
    const moved = s.wallet[0]?.movements.reduce((acc, m) => acc + m.amount, 0n);
    expect(moved).toBe(BigInt(LEDGER_REASONS.length));
    expect(new Set(Object.values(WALLET_REPORT_GROUP_OF)).size).toBeGreaterThan(1);
  });
});

describe('financialGranularityFor', () => {
  it('reads an hour as a day, and follows the report rule beyond it', () => {
    expect(financialGranularityFor(1)).toBe('DAY');
    expect(financialGranularityFor(31)).toBe('DAY');
    expect(financialGranularityFor(32)).toBe('WEEK');
    expect(financialGranularityFor(187)).toBe('MONTH');
  });
});
