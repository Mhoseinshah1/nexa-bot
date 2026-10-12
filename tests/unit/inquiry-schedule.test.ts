import { describe, expect, it } from 'vitest';
import {
  PAYMENT_GATEWAY_PROVIDERS,
  TONPAYS_INQUIRY_BUDGET_PER_MINUTE,
  TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE,
  TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE,
} from '@nexa/contracts';
import {
  BACKOFF_SCHEDULE,
  INQUIRY_JITTER_RATIO,
  TONPAYS_INQUIRY_SCHEDULE,
  firstInquiryAt,
  hintReservePerMinute,
  inquiryScheduleFor,
  jitteredMs,
  nextScheduledInquiryAt,
} from '../../apps/api/src/modules/commerce/payments/domain/inquiry-schedule';
import { reviewInquiryNextAt } from '../../apps/api/src/modules/commerce/payments/domain/tonpays-telegram';
import { inquiryBackoffMs } from '../../apps/api/src/modules/commerce/payments/domain/tonpays';

/**
 * FIX-06: when each provider is asked. Every number here is the schedule's promise to a
 * customer (how long an approval can wait to be seen) or to a provider (how often it is
 * asked); a change to either should fail a line here first.
 */

const T0 = new Date(Date.UTC(2026, 9, 10, 9, 0, 0));
const PAY = '01a124d8-2d39-7241-b171-6fcfd79ae768';

/** Every ask a schedule makes over `horizonMs` for one invoice, with no hint, jitter included. */
function asks(provider: (typeof PAYMENT_GATEWAY_PROVIDERS)[number], horizonMs: number, pay = PAY) {
  const schedule = inquiryScheduleFor(provider);
  const out: number[] = [];
  let at = firstInquiryAt(schedule, T0, pay);
  let attempt = 1;
  while (at.getTime() - T0.getTime() < horizonMs) {
    out.push(at.getTime() - T0.getTime());
    at = nextScheduledInquiryAt(schedule, { at, attempt, invoiceCreatedAt: T0, paymentId: pay });
    attempt += 1;
  }
  return out;
}

const gaps = (times: number[]) => times.slice(1).map((t, i) => t - times[i]!);

describe('the jitter', () => {
  it('is deterministic per payment and step, and stays inside ±10 % (rounded to the millisecond)', () => {
    expect(jitteredMs(10_000, PAY, 3)).toBe(jitteredMs(10_000, PAY, 3));
    const seen = new Set<number>();
    for (let step = 0; step < 200; step += 1) {
      for (const pay of [PAY, 'another-payment', 'a-third']) {
        const value = jitteredMs(10_000, pay, step);
        expect(value).toBeGreaterThanOrEqual(10_000 * (1 - INQUIRY_JITTER_RATIO));
        expect(value).toBeLessThanOrEqual(10_000 * (1 + INQUIRY_JITTER_RATIO));
        seen.add(value);
      }
    }
    // It actually spreads: invoices created together do not ask together for ever.
    expect(seen.size).toBeGreaterThan(100);
  });
});

describe('TONPAYS: frequent while a customer is waiting, then decaying to the old cap', () => {
  it('asks first about ten seconds after the invoice, not twenty', () => {
    const first = firstInquiryAt(TONPAYS_INQUIRY_SCHEDULE, T0, PAY).getTime() - T0.getTime();
    expect(first).toBeGreaterThanOrEqual(9_000);
    expect(first).toBeLessThan(11_000);
  });

  it('leaves no gap over 11 s in the first two minutes, 33 s to five, 66 s to fifteen, 132 s to thirty, 330 s after', () => {
    const times = asks('TONPAYS', 70 * 60_000);
    const bounds: [number, number][] = [
      [120_000, 11_000],
      [300_000, 33_000],
      [900_000, 66_000],
      [1_800_000, 132_000],
      [Number.POSITIVE_INFINITY, 330_000],
    ];
    gaps(times).forEach((gap, i) => {
      const askedAt = times[i]!;
      const bound = bounds.find(([until]) => askedAt < until)![1];
      expect(gap, `gap after the ask at ${String(askedAt)} ms`).toBeLessThanOrEqual(bound);
    });
  });

  it('stays inside the scheduled share of the budget: at most 6 asks a minute per invoice, about 44 over 70 minutes', () => {
    const times = asks('TONPAYS', 70 * 60_000);
    for (let minute = 0; minute < 70; minute += 1) {
      const inMinute = times.filter((t) => t >= minute * 60_000 && t < (minute + 1) * 60_000);
      expect(inMinute.length).toBeLessThanOrEqual(7);
    }
    expect(times.length).toBeGreaterThan(35);
    expect(times.length).toBeLessThan(55);
    // Five fresh invoices at the full rate fit the scheduled share (40 less the reserve).
    const scheduledShare =
      TONPAYS_INQUIRY_BUDGET_PER_MINUTE - hintReservePerMinute(TONPAYS_INQUIRY_BUDGET_PER_MINUTE);
    expect(scheduledShare).toBe(30);
    expect(5 * 6).toBeLessThanOrEqual(scheduledShare);
  });

  it('measures age from the invoice, so a late hint does not reset the fast phase', () => {
    const at = new Date(T0.getTime() + 20 * 60_000);
    const next = nextScheduledInquiryAt(TONPAYS_INQUIRY_SCHEDULE, {
      at,
      attempt: 2,
      invoiceCreatedAt: T0,
      paymentId: PAY,
    });
    expect(next.getTime() - at.getTime()).toBeGreaterThan(100_000);
  });
});

describe('every other provider keeps the original schedule, jittered', () => {
  it.each(['NOWPAYMENTS', 'CENTRALPAY', 'TONPAYS_TELEGRAM', 'TELEGRAM_STARS'] as const)(
    '%s: 20 s, then 40, 80, 160, 300 s (±10 %)',
    (provider) => {
      expect(inquiryScheduleFor(provider)).toBe(BACKOFF_SCHEDULE);
      const times = asks(provider, 30 * 60_000);
      expect(times[0]).toBeGreaterThanOrEqual(18_000);
      expect(times[0]).toBeLessThan(22_000);
      gaps(times).forEach((gap, i) => {
        const nominal = inquiryBackoffMs(i + 1);
        expect(gap).toBeGreaterThanOrEqual(nominal * 0.9 - 1);
        expect(gap).toBeLessThanOrEqual(nominal * 1.1 + 1);
      });
    },
  );

  it('names a schedule for every provider there is', () => {
    for (const provider of PAYMENT_GATEWAY_PROVIDERS) {
      expect(inquiryScheduleFor(provider)).toBeDefined();
    }
  });
});

describe('TONPAYS_TELEGRAM in review', () => {
  const start = T0;
  const until = new Date(T0.getTime() + 24 * 3_600_000);

  it('asks every 30 s for the first ten minutes after the acknowledgement, then every 120 s to the hour', () => {
    expect(TONPAYS_TELEGRAM_REVIEW_INQUIRY_CADENCE[0]).toEqual({
      untilMs: 600_000,
      intervalMs: 30_000,
    });
    const early = reviewInquiryNextAt(start, until, new Date(T0.getTime() + 60_000))!;
    expect(early.getTime() - T0.getTime() - 60_000).toBe(30_000);
    const later = reviewInquiryNextAt(start, until, new Date(T0.getTime() + 11 * 60_000))!;
    expect(later.getTime() - T0.getTime() - 11 * 60_000).toBe(120_000);
  });

  it('spends at most 2 of the route’s 15 inquiries a minute on one review, and 20 in its first ten minutes', () => {
    let at = start;
    let count = 0;
    while (at.getTime() - start.getTime() < 600_000) {
      at = reviewInquiryNextAt(start, until, at)!;
      count += 1;
    }
    expect(count).toBeLessThanOrEqual(21);
    expect(TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE).toBe(15);
    expect(
      TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE -
        hintReservePerMinute(TONPAYS_TELEGRAM_INQUIRY_BUDGET_PER_MINUTE),
    ).toBe(12);
  });

  it('jitters a step without ever passing the last question before the deadline', () => {
    const lateAt = new Date(until.getTime() - 20_000);
    const last = reviewInquiryNextAt(start, until, lateAt, (ms) => ms * 1.1)!;
    expect(last.getTime()).toBe(until.getTime() - 15_000);
  });
});

describe('the hint reserve', () => {
  it('keeps a quarter of each inquiry budget, at least one, for hinted rows', () => {
    expect(hintReservePerMinute(40)).toBe(10);
    expect(hintReservePerMinute(15)).toBe(3);
    expect(hintReservePerMinute(2)).toBe(1);
  });
});
