import { describe, expect, it } from 'vitest';
import { money } from '@nexa/contracts';
import {
  effectiveMonthlyMinimum,
  minimumStanding,
} from '../../apps/api/src/modules/commerce/resellers/domain/monthly-minimum';
import { TenantMonthlyPeriods } from '../../apps/api/src/infrastructure/time/monthly-period';

/**
 * The reseller monthly minimum (round N R2, `docs/round-n-reseller-audit.md` §3): which
 * minimum applies, where a reseller stands, and the month it is measured over.
 */

const IRT = (amount: bigint) => money(amount, 'IRT');

describe('effectiveMonthlyMinimum: the reseller’s own, else the tier’s', () => {
  it('inherits the tier’s when the reseller has none (null)', () => {
    expect(effectiveMonthlyMinimum(IRT(1_000_000n), null)).toEqual({
      minimum: IRT(1_000_000n),
      source: 'TIER',
    });
  });

  it('takes the reseller’s own over the tier’s, higher or lower', () => {
    expect(effectiveMonthlyMinimum(IRT(1_000_000n), IRT(250_000n))).toEqual({
      minimum: IRT(250_000n),
      source: 'RESELLER',
    });
    expect(effectiveMonthlyMinimum(null, IRT(5_000_000n))).toEqual({
      minimum: IRT(5_000_000n),
      source: 'RESELLER',
    });
  });

  it('reads an own ZERO as an explicit “no minimum”, overriding the tier’s', () => {
    expect(effectiveMonthlyMinimum(IRT(1_000_000n), IRT(0n))).toEqual({
      minimum: null,
      source: 'NONE',
    });
  });

  it('reads a tier’s null or zero as no minimum (Mirza: 0 means none)', () => {
    expect(effectiveMonthlyMinimum(null, null)).toEqual({ minimum: null, source: 'NONE' });
    expect(effectiveMonthlyMinimum(IRT(0n), null)).toEqual({ minimum: null, source: 'NONE' });
  });
});

describe('minimumStanding', () => {
  it('is BELOW with the exact remainder, floored progress', () => {
    expect(minimumStanding('ACTIVE', IRT(1_000_000n), 333_333n)).toEqual({
      state: 'BELOW',
      remaining: 666_667n,
      progressBasisPoints: 3_333,
    });
  });

  it('never shows 100% one minor unit short, and is ACHIEVED at exactly the minimum', () => {
    expect(minimumStanding('ACTIVE', IRT(1_000_000n), 999_999n)).toEqual({
      state: 'BELOW',
      remaining: 1n,
      progressBasisPoints: 9_999,
    });
    expect(minimumStanding('ACTIVE', IRT(1_000_000n), 1_000_000n)).toEqual({
      state: 'ACHIEVED',
      remaining: 0n,
      progressBasisPoints: 10_000,
    });
    expect(minimumStanding('ACTIVE', IRT(1_000_000n), 2_500_000n).progressBasisPoints).toBe(25_000);
  });

  it('has no minimum, and no figures, when none applies', () => {
    expect(minimumStanding('ACTIVE', null, 5n)).toEqual({
      state: 'NO_MINIMUM',
      remaining: null,
      progressBasisPoints: null,
    });
  });

  it('applies nothing to a SUSPENDED reseller, who is an ordinary customer (R1)', () => {
    expect(minimumStanding('SUSPENDED', IRT(1_000_000n), 0n)).toEqual({
      state: 'NOT_ACTIVE',
      remaining: null,
      progressBasisPoints: null,
    });
  });

  it('keeps an absurd ratio an exact number', () => {
    const standing = minimumStanding('ACTIVE', IRT(1n), 10n ** 18n);
    expect(Number.isSafeInteger(standing.progressBasisPoints)).toBe(true);
    expect(standing.state).toBe('ACHIEVED');
  });
});

describe('TenantMonthlyPeriods: the month in the tenant’s timezone and calendar', () => {
  const periods = new TenantMonthlyPeriods();
  const tehran = { timezone: 'Asia/Tehran', calendar: 'jalali' as const };
  const berlin = { timezone: 'Europe/Berlin', calendar: 'gregorian' as const };

  it('is the Jalali month, local midnight to local midnight, half-open', () => {
    // 2026-09-29 is 1405/07/07 in Tehran (UTC+03:30). Mehr 1405 runs 23 Sep – 22 Oct.
    const now = new Date('2026-09-29T12:00:00Z');
    const month = periods.month('THIS_MONTH', now, tehran);
    expect(month.start.toISOString()).toBe('2026-09-22T20:30:00.000Z');
    expect(month.end.toISOString()).toBe('2026-10-22T20:30:00.000Z');
    expect(month.startLocal).toBe('1405/07/01');
    expect(month.endLocalInclusive).toBe('1405/07/30');
    expect(month.running).toBe(true);

    const previous = periods.month('PREVIOUS_MONTH', now, tehran);
    // Shahrivar has 31 days; its end is Mehr's start, so no instant is in both or neither.
    expect(previous.end.toISOString()).toBe(month.start.toISOString());
    expect(previous.startLocal).toBe('1405/06/01');
    expect(previous.endLocalInclusive).toBe('1405/06/31');
    expect(previous.running).toBe(false);
  });

  it('puts the last instant before local midnight in the old month and midnight in the new', () => {
    const lastInstant = new Date('2026-10-22T20:29:59.999Z');
    const firstInstant = new Date('2026-10-22T20:30:00.000Z');
    expect(periods.month('THIS_MONTH', lastInstant, tehran).startLocal).toBe('1405/07/01');
    expect(periods.month('THIS_MONTH', firstInstant, tehran).startLocal).toBe('1405/08/01');
  });

  it('starts the three-day reminder at local midnight of the third-to-last day', () => {
    const now = new Date('2026-09-29T12:00:00Z');
    // 1405/07/28 00:00 Tehran: the 28th, 29th and 30th remain.
    expect(periods.reminderStart(now, 3, tehran).toISOString()).toBe('2026-10-19T20:30:00.000Z');
    expect(periods.reminderStart(now, 1, tehran).toISOString()).toBe('2026-10-21T20:30:00.000Z');
  });

  it('counts days left, today included', () => {
    const end = new Date('2026-10-22T20:30:00.000Z');
    expect(periods.daysLeft(new Date('2026-10-19T20:30:00.000Z'), end, tehran)).toBe(3);
    expect(periods.daysLeft(new Date('2026-10-22T10:00:00.000Z'), end, tehran)).toBe(1);
    expect(periods.daysLeft(end, end, tehran)).toBe(0);
  });

  it('is DST-safe: a month containing a spring-forward change', () => {
    // Europe/Berlin moves from +01:00 to +02:00 on 29 March 2026.
    const now = new Date('2026-03-15T12:00:00Z');
    const month = periods.month('THIS_MONTH', now, berlin);
    expect(month.start.toISOString()).toBe('2026-02-28T23:00:00.000Z');
    expect(month.end.toISOString()).toBe('2026-03-31T22:00:00.000Z');
    // Midnight of the 29th is still +01:00: the change happens at 02:00.
    expect(periods.reminderStart(now, 3, berlin).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    // Noon on the 29th (a 23-hour day) still has three days left: the 29th, 30th and 31st.
    expect(periods.daysLeft(new Date('2026-03-29T10:00:00Z'), month.end, berlin)).toBe(3);
  });

  it('is DST-safe: a month containing a fall-back change', () => {
    // Europe/Berlin moves from +02:00 to +01:00 on 25 October 2026.
    const now = new Date('2026-10-10T12:00:00Z');
    const month = periods.month('THIS_MONTH', now, berlin);
    expect(month.start.toISOString()).toBe('2026-09-30T22:00:00.000Z');
    expect(month.end.toISOString()).toBe('2026-10-31T23:00:00.000Z');
    expect(periods.daysLeft(new Date('2026-10-25T12:00:00Z'), month.end, berlin)).toBe(7);
  });
});
