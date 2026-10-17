import { describe, expect, it } from 'vitest';
import {
  amountOf,
  buildTenantMoneyReport,
  parseMinor,
  paymentPurposeOf,
  reconcile,
  summarisePayments,
  summariseWalletTransactions,
  summariseWheel,
  totalOf,
  type CustomerOpeningEvidence,
  type TenantMoneyInput,
} from '../../apps/api/src/modules/platform/legacy-history/application/money-reconciliation';

/**
 * Mirza `.nxpkg` importer — the money history's pure rules: amounts are bigint minor units
 * with a currency (never a float, never a currency-less sum), successful payments are split
 * by purpose and every other outcome is kept apart, and the reconciliation keeps the snapshot
 * authoritative. SYNTHETIC values only.
 */

const check = (over: Partial<CustomerOpeningEvidence['checks'][number]> = {}) => ({
  verdict: 'MATCHES_SNAPSHOT',
  snapshotMinor: '150000',
  snapshotCurrency: 'IRT',
  historyLastMinor: '150000',
  historyLastCurrency: 'IRT',
  deltaMinor: null,
  ...over,
});

const evidence = (over: Partial<CustomerOpeningEvidence> = {}): CustomerOpeningEvidence => ({
  openingCredits: [{ amountMinor: 150000n, currency: 'IRT' }],
  openingNonCredits: 0,
  openingReferenceMatches: true,
  debt: null,
  checks: [check()],
  differences: [],
  ...over,
});

describe('amounts', () => {
  it('reads integer strings as bigint and refuses anything else', () => {
    expect(parseMinor('9007199254740993')).toBe(9007199254740993n);
    expect(parseMinor('-25')).toBe(-25n);
    for (const bad of ['1.5', '1e3', '', ' 1', null, undefined, '0x10']) {
      expect(parseMinor(bad as string | null)).toBeNull();
    }
  });

  it('an amount needs a known currency', () => {
    expect(amountOf('10', 'IRT')).toEqual({ amountMinor: 10n, currency: 'IRT' });
    expect(amountOf('10', 'TOMAN')).toBeNull();
    expect(amountOf('10', null)).toBeNull();
  });

  it('sums per currency, counts unparsed and foreign-currency rows without summing them', () => {
    const total = totalOf([
      { currency: 'IRT', count: 3, sumMinor: 9007199254740993n, unparsed: 1 },
      { currency: 'IRT', count: 2, sumMinor: 7n, unparsed: 0 },
      { currency: 'USD', count: 1, sumMinor: 250n, unparsed: 0 },
      { currency: 'XYZ', count: 4, sumMinor: 999n, unparsed: 0 },
    ]);
    expect(total).toEqual({
      count: 10,
      amounts: [
        { amountMinor: 9007199254741000n, currency: 'IRT' },
        { amountMinor: 250n, currency: 'USD' },
      ],
      unparsedAmounts: 1,
      unrecognisedCurrency: 4,
    });
    expect(typeof total.amounts[0]?.amountMinor).toBe('bigint');
  });
});

describe('payments', () => {
  it('classifies purpose, telling admin adjustments apart by method', () => {
    expect(paymentPurposeOf('CARD_TO_CARD', 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT')).toBe(
      'WALLET_TOP_UP',
    );
    expect(paymentPurposeOf('ADMIN_CREDIT_ADJUSTMENT', 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT')).toBe(
      'ADMIN_CREDIT',
    );
    expect(paymentPurposeOf('ADMIN_DEBIT_ADJUSTMENT', 'NOT_IN_SOURCE')).toBe('ADMIN_DEBIT');
    for (const tag of [
      'BUY_SERVICE_AFTER_PAYMENT',
      'EXTEND_SERVICE',
      'EXTRA_VOLUME',
      'EXTRA_TIME',
    ]) {
      expect(paymentPurposeOf('GATEWAY_RIAL_1', tag)).toBe('SERVICE_PURCHASE');
    }
    expect(paymentPurposeOf('CARD_TO_CARD', 'NOT_IN_SOURCE')).toBe('PURPOSE_NOT_IN_SOURCE');
    expect(paymentPurposeOf('CARD_TO_CARD', null)).toBe('PURPOSE_NOT_IN_SOURCE');
    expect(paymentPurposeOf('CARD_TO_CARD', 'SOMETHING_NEW')).toBe('OTHER');
  });

  it('counts only SUCCEEDED in the purpose totals; failed, pending, cancelled and unknown apart', () => {
    const g = (outcome: string | null, purpose: string, sum: bigint, method = 'CARD_TO_CARD') => ({
      outcome,
      method,
      purpose,
      currency: 'IRT',
      count: 1,
      sumMinor: sum,
      unparsed: 0,
    });
    const summary = summarisePayments([
      g('SUCCEEDED', 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT', 100n),
      g('SUCCEEDED', 'EXTEND_SERVICE', 40n),
      g('SUCCEEDED', 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT', 7n, 'ADMIN_CREDIT_ADJUSTMENT'),
      g('FAILED', 'WALLET_TOP_UP_OR_ADMIN_ADJUSTMENT', 1000n),
      g('PENDING', 'EXTEND_SERVICE', 2000n),
      g('CANCELLED', 'EXTEND_SERVICE', 3000n),
      g('weird', 'EXTEND_SERVICE', 4000n),
    ]);
    expect(
      summary.succeededByPurpose.map((r) => [r.purpose, r.total.amounts[0]?.amountMinor]),
    ).toEqual([
      ['WALLET_TOP_UP', 100n],
      ['SERVICE_PURCHASE', 40n],
      ['ADMIN_CREDIT', 7n],
    ]);
    expect(
      summary.excludedByOutcome.map((r) => [r.outcome, r.total.amounts[0]?.amountMinor]),
    ).toEqual([
      ['FAILED', 1000n],
      ['PENDING', 2000n],
      ['CANCELLED', 3000n],
      ['UNKNOWN', 4000n],
    ]);
  });
});

describe('wallet transactions and the wheel', () => {
  it('reports debits as magnitudes and keeps zero and unparsed rows out of the sums', () => {
    const w = summariseWalletTransactions([
      {
        currency: 'IRT',
        inCount: 2,
        inSumMinor: 500n,
        outCount: 3,
        outSumMinor: -120n,
        zeroCount: 4,
        unparsed: 1,
      },
    ]);
    expect(w.moneyIn.amounts).toEqual([{ amountMinor: 500n, currency: 'IRT' }]);
    expect(w.moneyOut).toMatchObject({
      count: 3,
      amounts: [{ amountMinor: 120n, currency: 'IRT' }],
    });
    expect(w.noChange).toBe(4);
    expect(w.unparsedAmounts).toBe(1);
  });

  it('sums only the prizes that were won', () => {
    const wheel = summariseWheel([
      { won: true, currency: 'IRT', count: 2, sumMinor: 20000n, unparsed: 0 },
      { won: false, currency: 'IRT', count: 5, sumMinor: 0n, unparsed: 0 },
    ]);
    expect(wheel.spins).toBe(7);
    expect(wheel.prizesWon).toMatchObject({ count: 2, amounts: [{ amountMinor: 20000n }] });
  });
});

describe('the reconciliation (snapshot authoritative, history evidence)', () => {
  it('RECONCILED when opening = snapshot and the history walk ends there', () => {
    const r = reconcile(evidence());
    expect(r.status).toBe('RECONCILED');
    expect(r.openingEqualsSnapshot).toBe(true);
    expect(r.openingFigure).toEqual({ amountMinor: 150000n, currency: 'IRT' });
  });

  it('keeps the snapshot when the history differs, and states the delta', () => {
    const r = reconcile(
      evidence({
        checks: [
          check({
            verdict: 'DIFFERS_FROM_SNAPSHOT',
            historyLastMinor: '140000',
            deltaMinor: '10000',
          }),
        ],
        differences: [{ cause: 'ACTIVITY_AFTER_HISTORY_INEXACT', certainty: 'PROBABLE' }],
      }),
    );
    expect(r.status).toBe('HISTORY_DIFFERS_SNAPSHOT_KEPT');
    expect(r.openingFigure).toEqual({ amountMinor: 150000n, currency: 'IRT' });
    expect(r.deltaSnapshotMinusHistory).toEqual({ amountMinor: 10000n, currency: 'IRT' });
    expect(r.difference).toEqual({
      cause: 'ACTIVITY_AFTER_HISTORY_INEXACT',
      certainty: 'PROBABLE',
    });
  });

  it('a debt is a negative opening figure; zero balance with no entries reconciles to zero', () => {
    const debt = reconcile(
      evidence({
        openingCredits: [],
        debt: { amountMinor: 30000n, currency: 'IRT', state: 'PENDING_REVIEW' },
        checks: [check({ snapshotMinor: '-30000', historyLastMinor: '-30000' })],
      }),
    );
    expect(debt.status).toBe('RECONCILED');
    expect(debt.openingFigure).toEqual({ amountMinor: -30000n, currency: 'IRT' });
    const zero = reconcile(
      evidence({
        openingCredits: [],
        openingReferenceMatches: null,
        checks: [check({ snapshotMinor: '0', historyLastMinor: '0' })],
      }),
    );
    expect(zero.status).toBe('RECONCILED');
    expect(zero.openingFigure).toEqual({ amountMinor: 0n, currency: 'IRT' });
  });

  it('flags an opening that is not the snapshot', () => {
    const r = reconcile(evidence({ openingCredits: [{ amountMinor: 150001n, currency: 'IRT' }] }));
    expect(r.status).toBe('OPENING_DIFFERS_FROM_SNAPSHOT');
    expect(r.openingEqualsSnapshot).toBe(false);
    // A zero snapshot with a credit written is a difference too.
    expect(reconcile(evidence({ checks: [check({ snapshotMinor: '0' })] })).status).toBe(
      'OPENING_DIFFERS_FROM_SNAPSHOT',
    );
  });

  it('refuses a malformed opening: two credits, a debit, a foreign reference, credit and debt', () => {
    const two = [
      { amountMinor: 1n, currency: 'IRT' },
      { amountMinor: 1n, currency: 'IRT' },
    ];
    expect(reconcile(evidence({ openingCredits: two })).status).toBe('OPENING_INVALID');
    expect(reconcile(evidence({ openingNonCredits: 1 })).status).toBe('OPENING_INVALID');
    expect(reconcile(evidence({ openingReferenceMatches: false })).status).toBe('OPENING_INVALID');
    expect(
      reconcile(evidence({ debt: { amountMinor: 1n, currency: 'IRT', state: 'PENDING_REVIEW' } }))
        .status,
    ).toBe('OPENING_INVALID');
    expect(
      reconcile(evidence({ openingCredits: [{ amountMinor: 5n, currency: 'TOMAN' }] })).status,
    ).toBe('OPENING_INVALID');
  });

  it('without a wallet-history check: NO_WALLET_HISTORY, or NO_OPENING_FIGURE when nothing exists', () => {
    expect(reconcile(evidence({ checks: [] })).status).toBe('NO_WALLET_HISTORY');
    expect(
      reconcile(evidence({ checks: [], openingCredits: [], openingReferenceMatches: null })).status,
    ).toBe('NO_OPENING_FIGURE');
  });

  it('believes a verdict only when the closing evidence says the same thing', () => {
    const status = (over: Parameters<typeof check>[0]) =>
      reconcile(evidence({ checks: [check(over)] })).status;
    // MATCHES needs a readable closing balance equal to the snapshot.
    expect(status({ historyLastMinor: '149999' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ historyLastMinor: null })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ historyLastMinor: 'x' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ historyLastCurrency: 'USD' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ deltaMinor: '5' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ deltaMinor: '0' })).toBe('RECONCILED');
    // DIFFERS needs a closing balance that differs, and a stated delta of snapshot − closing.
    const differs = { verdict: 'DIFFERS_FROM_SNAPSHOT', historyLastMinor: '140000' };
    expect(status(differs)).toBe('HISTORY_DIFFERS_SNAPSHOT_KEPT');
    expect(status({ ...differs, deltaMinor: '10000' })).toBe('HISTORY_DIFFERS_SNAPSHOT_KEPT');
    expect(status({ ...differs, deltaMinor: '9999' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ ...differs, historyLastMinor: '150000' })).toBe('UNREADABLE_EVIDENCE');
    expect(status({ ...differs, historyLastMinor: null })).toBe('UNREADABLE_EVIDENCE');
  });

  it('ambiguous and unreadable evidence never reads as reconciled', () => {
    expect(reconcile(evidence({ checks: [check(), check()] })).status).toBe('AMBIGUOUS_EVIDENCE');
    expect(reconcile(evidence({ checks: [check({ snapshotMinor: '1.5' })] })).status).toBe(
      'UNREADABLE_EVIDENCE',
    );
    expect(reconcile(evidence({ checks: [check({ snapshotCurrency: 'IRR' })] })).status).toBe(
      'OPENING_DIFFERS_FROM_SNAPSHOT',
    );
    expect(reconcile(evidence({ checks: [check({ verdict: 'NEW_VERDICT' })] })).status).toBe(
      'UNREADABLE_EVIDENCE',
    );
  });
});

describe('the tenant-wide report', () => {
  const input = (over: Partial<TenantMoneyInput> = {}): TenantMoneyInput => ({
    customers: [
      evidence(),
      evidence(),
      evidence({
        openingCredits: [],
        debt: { amountMinor: 30000n, currency: 'IRT', state: 'PENDING_REVIEW' },
        checks: [
          check({
            snapshotMinor: '-30000',
            historyLastMinor: '-25000',
            verdict: 'DIFFERS_FROM_SNAPSHOT',
            deltaMinor: '-5000',
          }),
        ],
      }),
    ],
    unlinkedChecks: 0,
    stated: [
      {
        walletCustomers: 2,
        walletAfterTotalMinor: '300000',
        walletBeforeTotalMinor: '0',
        walletCurrency: 'IRT',
        debtCount: 1,
        debtTotalMinor: '30000',
        debtCurrency: 'IRT',
      },
    ],
    payments: [],
    walletTransactions: [],
    wheel: [],
    serviceOperations: [],
    referrals: { records: 0, referrerGiftsPaid: 0 },
    discountsUsed: 0,
    ledgerReasons: [{ reason: 'MIGRATION_OPENING_BALANCE', count: 2 }],
    ...over,
  });

  it('states every opening equals the snapshot when the checks and the import totals agree', () => {
    const report = buildTenantMoneyReport(input());
    expect(report.opening.credits).toMatchObject({ count: 2, amounts: [{ amountMinor: 300000n }] });
    expect(report.opening.matchesImportStatement).toBe(true);
    expect(report.opening.debtsMatchImportStatement).toBe(true);
    expect(report.snapshotCheck).toEqual({
      checked: 3,
      openingEqualsSnapshot: 3,
      notProvenEqual: 0,
      openingsWithoutCheck: 0,
      unlinkedChecks: 0,
    });
    expect(report.byVerdict).toEqual([
      { verdict: 'DIFFERS_FROM_SNAPSHOT', customers: 1 },
      { verdict: 'MATCHES_SNAPSHOT', customers: 2 },
    ]);
    expect(report.statement).toEqual({
      everyOpeningEqualsSnapshot: true,
      basis: 'PER_CUSTOMER_CHECK_AND_IMPORT_TOTALS',
    });
  });

  it('says NO when one opening differs, or the ledger total is not the import statement', () => {
    const differs = buildTenantMoneyReport(
      input({ customers: [evidence({ openingCredits: [{ amountMinor: 1n, currency: 'IRT' }] })] }),
    );
    expect(differs.statement.everyOpeningEqualsSnapshot).toBe(false);
    const total = buildTenantMoneyReport(
      input({
        stated: [{ ...input().stated[0]!, walletAfterTotalMinor: '300001' }],
      }),
    );
    expect(total.opening.matchesImportStatement).toBe(false);
    expect(total.statement.everyOpeningEqualsSnapshot).toBe(false);
  });

  it('says UNKNOWN, never YES, when an opening had no wallet-history check to compare with', () => {
    const base = input();
    const report = buildTenantMoneyReport({
      ...base,
      customers: [base.customers[0]!, evidence({ checks: [] }), base.customers[2]!],
    });
    expect(report.snapshotCheck.openingsWithoutCheck).toBe(1);
    expect(report.statement.everyOpeningEqualsSnapshot).toBeNull();
    // ...and with no import statement either, still not YES.
    const alone = buildTenantMoneyReport({
      ...base,
      stated: [],
      customers: [evidence({ checks: [] })],
    });
    expect(alone.statement.everyOpeningEqualsSnapshot).toBeNull();
    // A contradiction still wins: NO, not UNKNOWN.
    const differs = buildTenantMoneyReport({
      ...base,
      customers: [
        evidence({ checks: [] }),
        evidence({ openingCredits: [{ amountMinor: 1n, currency: 'IRT' }] }),
      ],
    });
    expect(differs.statement.everyOpeningEqualsSnapshot).toBe(false);
  });

  it('falls back to the per-customer basis without exactly one import statement', () => {
    const report = buildTenantMoneyReport(input({ stated: [] }));
    expect(report.statement).toEqual({
      everyOpeningEqualsSnapshot: true,
      basis: 'PER_CUSTOMER_CHECK_ONLY',
    });
  });
});
