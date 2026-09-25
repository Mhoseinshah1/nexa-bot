import { describe, expect, it } from 'vitest';
import {
  LEDGER_REASONS,
  ORDER_PURPOSES,
  REPORT_FAILED_PAYMENT_STATES,
  PAYMENT_RESOLVED_STATES,
  SALE_ORDER_PURPOSES,
  WALLET_REPORT_GROUP_OF,
  ledgerReasonsIn,
  orderPurposeIsSale,
  reportGranularityFor,
  reportRangeQuerySchema,
} from '@nexa/contracts';

/**
 * The WP12 reporting vocabulary (`docs/wp12-business-analytics-audit.md` §3, §4).
 *
 * Each rule here is one a report query reads, so each has the assertion that would fail
 * if it were quietly changed.
 */
describe('reporting contracts', () => {
  it('counts every commercial purpose as a sale and never a trial', () => {
    expect([...SALE_ORDER_PURPOSES].sort()).toEqual(
      ['ADD_TIME', 'ADD_TRAFFIC', 'NEW_SERVICE', 'RENEW'].sort(),
    );
    expect(orderPurposeIsSale('TRIAL')).toBe(false);
    for (const purpose of ORDER_PURPOSES)
      expect(typeof orderPurposeIsSale(purpose)).toBe('boolean');
  });

  it('classifies every ledger reason into exactly one wallet group, top-ups apart from gifts', () => {
    expect(Object.keys(WALLET_REPORT_GROUP_OF).sort()).toEqual([...LEDGER_REASONS].sort());
    expect([...ledgerReasonsIn('TOPUP')].sort()).toEqual(
      ['TOPUP_CRYPTO', 'TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS'].sort(),
    );
    // Cashback, gifts and commissions are never a top-up: that is wallet inflow the
    // customer paid for, and the other three are money the business gave away.
    for (const reason of [
      'CASHBACK_TOPUP',
      'REFERRAL_SIGNUP_GIFT',
      'REFERRAL_COMMISSION',
    ] as const) {
      expect(WALLET_REPORT_GROUP_OF[reason]).not.toBe('TOPUP');
    }
    expect(WALLET_REPORT_GROUP_OF.RECEIPT_CREDIT).toBe('RECEIPT_CREDIT');
    expect(WALLET_REPORT_GROUP_OF.PURCHASE).toBe('SPENDING');
  });

  it('counts only the money-less terminal states as a failed payment', () => {
    expect([...REPORT_FAILED_PAYMENT_STATES].sort()).toEqual([...PAYMENT_RESOLVED_STATES].sort());
    expect(REPORT_FAILED_PAYMENT_STATES as readonly string[]).not.toContain('PENDING');
    expect(REPORT_FAILED_PAYMENT_STATES as readonly string[]).not.toContain('UNKNOWN');
  });

  it('chooses the granularity from the number of local days', () => {
    expect(reportGranularityFor(1)).toBe('HOUR');
    expect(reportGranularityFor(2)).toBe('DAY');
    expect(reportGranularityFor(31)).toBe('DAY');
    expect(reportGranularityFor(32)).toBe('WEEK');
    expect(reportGranularityFor(186)).toBe('WEEK');
    expect(reportGranularityFor(187)).toBe('MONTH');
    expect(reportGranularityFor(366)).toBe('MONTH');
  });

  it('requires from and to exactly when the range is CUSTOM', () => {
    expect(reportRangeQuerySchema.safeParse({ range: 'TODAY' }).success).toBe(true);
    expect(
      reportRangeQuerySchema.safeParse({ range: 'CUSTOM', from: '1405-07-01', to: '1405-07-30' })
        .success,
    ).toBe(true);
    expect(reportRangeQuerySchema.safeParse({ range: 'CUSTOM', from: '1405-07-01' }).success).toBe(
      false,
    );
    expect(
      reportRangeQuerySchema.safeParse({ range: 'TODAY', from: '1405-07-01', to: '1405-07-02' })
        .success,
    ).toBe(false);
    expect(
      reportRangeQuerySchema.safeParse({ range: 'CUSTOM', from: '1405/07/01', to: '1405-07-02' })
        .success,
    ).toBe(false);
    expect(reportRangeQuerySchema.safeParse({ range: 'ALL_TIME' }).success).toBe(false);
  });
});
