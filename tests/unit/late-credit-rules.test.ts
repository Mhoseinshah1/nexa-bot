import { describe, expect, it } from 'vitest';
import { PAYMENT_GATEWAY_DESCRIPTORS, PAYMENT_GATEWAY_PROVIDERS } from '@nexa/contracts';
import {
  cancelledAttemptPollingOpen,
  LATE_CREDIT_POLL_BACKOFF_MS,
  lateCreditAmountMatches,
  lateCreditPollAt,
  lateCreditPollDelayMs,
  lateCreditPollingOpen,
  lateCreditReference,
  lateCreditStateDecision,
  lateCreditWindowEnd,
} from '../../apps/api/src/modules/commerce/payments/domain/late-credit';

/**
 * R5A item 4 — the pure rules of a late gateway credit. Each is a way to credit money nobody
 * approved, or to credit it twice.
 */

const T0 = new Date('2026-10-20T10:00:00.000Z');
const HOUR = 3_600_000;

describe('lateCreditReference', () => {
  it('is <paymentId>:late-credit — the idempotency identity every writer and reader shares', () => {
    expect(lateCreditReference('0190-aaaa')).toBe('0190-aaaa:late-credit');
  });
});

describe('lateCreditStateDecision', () => {
  const at = (
    state: Parameters<typeof lateCreditStateDecision>[0]['state'],
    deadline: Date | null,
    orderAwaitingPayment?: boolean | null,
  ) =>
    lateCreditStateDecision(
      orderAwaitingPayment === undefined
        ? { state, deadline, now: T0 }
        : { state, deadline, now: T0, orderAwaitingPayment },
    );

  it('credits an EXPIRED or UNKNOWN payment as a LATE approval (behind the switch)', () => {
    expect(at('EXPIRED', new Date(T0.getTime() - 1))).toEqual({
      creditable: true,
      basis: 'LATE_APPROVAL',
    });
    expect(at('UNKNOWN', new Date(T0.getTime() + HOUR))).toEqual({
      creditable: true,
      basis: 'LATE_APPROVAL',
    });
  });

  it('credits a PENDING payment only once its deadline has passed — at it counts as past', () => {
    expect(at('PENDING', new Date(T0.getTime() + 1))).toEqual({
      creditable: false,
      reason: 'STILL_PAYABLE',
    });
    expect(at('PENDING', T0)).toEqual({ creditable: true, basis: 'LATE_APPROVAL' });
    expect(at('PENDING', new Date(T0.getTime() - 1))).toEqual({
      creditable: true,
      basis: 'LATE_APPROVAL',
    });
    // A null deadline is "past", never "none".
    expect(at('PENDING', null)).toEqual({ creditable: true, basis: 'LATE_APPROVAL' });
  });

  it('R12 F1: RETURNS the money of a CANCELLED attempt, before or after its deadline', () => {
    expect(at('CANCELLED', new Date(T0.getTime() + HOUR))).toEqual({
      creditable: true,
      basis: 'RETURNED',
    });
    expect(at('CANCELLED', new Date(T0.getTime() - HOUR))).toEqual({
      creditable: true,
      basis: 'RETURNED',
    });
    expect(at('CANCELLED', null)).toEqual({ creditable: true, basis: 'RETURNED' });
  });

  it('R12 F1: RETURNS a PENDING payment inside its deadline only when its order no longer awaits payment', () => {
    const inside = new Date(T0.getTime() + HOUR);
    expect(at('PENDING', inside, false)).toEqual({ creditable: true, basis: 'RETURNED' });
    // Awaiting payment: the ordinary settlement owns it. Not read (a top-up): never "not awaiting".
    for (const awaiting of [true, null, undefined]) {
      expect(at('PENDING', inside, awaiting)).toEqual({
        creditable: false,
        reason: 'STILL_PAYABLE',
      });
    }
    // Past its deadline it is a late approval whatever the order says.
    expect(at('PENDING', T0, false)).toEqual({ creditable: true, basis: 'LATE_APPROVAL' });
  });

  it('never credits a CONFIRMED or FAILED payment', () => {
    expect(at('CONFIRMED', null)).toEqual({ creditable: false, reason: 'ALREADY_CONFIRMED' });
    expect(at('FAILED', null)).toEqual({ creditable: false, reason: 'PAYMENT_CLOSED' });
    expect(at('FAILED', null, false)).toEqual({ creditable: false, reason: 'PAYMENT_CLOSED' });
  });
});

describe('cancelledAttemptPollingOpen (R12 F1)', () => {
  it('asks about a CANCELLED attempt until its own deadline, and no longer', () => {
    const deadline = new Date(T0.getTime() + HOUR);
    expect(cancelledAttemptPollingOpen({ state: 'CANCELLED', now: T0, deadline })).toBe(true);
    expect(cancelledAttemptPollingOpen({ state: 'CANCELLED', now: deadline, deadline })).toBe(
      false,
    );
    expect(cancelledAttemptPollingOpen({ state: 'CANCELLED', now: T0, deadline: null })).toBe(
      false,
    );
    for (const state of ['PENDING', 'EXPIRED', 'FAILED', 'CONFIRMED', 'UNKNOWN']) {
      expect(cancelledAttemptPollingOpen({ state, now: T0, deadline })).toBe(false);
    }
  });
});

describe('lateCreditAmountMatches', () => {
  it('accepts the figure Nexa sent, and an echo the provider did not send', () => {
    expect(lateCreditAmountMatches({ providerRequestAmount: 250_000n, sentAmount: 250_000n })).toBe(
      true,
    );
    expect(lateCreditAmountMatches({ providerRequestAmount: null, sentAmount: 250_000n })).toBe(
      true,
    );
  });

  it('refuses any other figure, high or low', () => {
    expect(lateCreditAmountMatches({ providerRequestAmount: 250_001n, sentAmount: 250_000n })).toBe(
      false,
    );
    expect(lateCreditAmountMatches({ providerRequestAmount: 1n, sentAmount: 250_000n })).toBe(
      false,
    );
    expect(lateCreditAmountMatches({ providerRequestAmount: 0n, sentAmount: 250_000n })).toBe(
      false,
    );
  });
});

describe('the late poll schedule', () => {
  it('is 5 minutes, then 15, then hourly for ever', () => {
    expect(LATE_CREDIT_POLL_BACKOFF_MS).toEqual([300_000, 900_000, 3_600_000]);
    expect([0, 1, 2, 3, 40].map(lateCreditPollDelayMs)).toEqual([
      300_000, 900_000, 3_600_000, 3_600_000, 3_600_000,
    ]);
    // A step that cannot be one is the first, never a crash.
    expect(lateCreditPollDelayMs(-4)).toBe(300_000);
    expect(lateCreditPollDelayMs(Number.NaN)).toBe(300_000);
  });

  it('jitters by at most 10 %, deterministically', () => {
    for (let step = 0; step < 3; step += 1) {
      const next = lateCreditPollAt({
        at: T0,
        paymentId: 'p-1',
        step,
        deadline: T0,
        windowMs: 48 * HOUR,
      });
      const delay = lateCreditPollDelayMs(step);
      expect(next).not.toBeNull();
      expect(next!.getTime() - T0.getTime()).toBeGreaterThanOrEqual(delay * 0.9);
      expect(next!.getTime() - T0.getTime()).toBeLessThanOrEqual(delay * 1.1);
      expect(
        lateCreditPollAt({ at: T0, paymentId: 'p-1', step, deadline: T0, windowMs: 48 * HOUR }),
      ).toEqual(next);
    }
  });

  it('asks its last question AT the window’s end, and none after', () => {
    const deadline = T0;
    const windowMs = 2 * HOUR;
    const end = lateCreditWindowEnd(deadline, windowMs);
    const lastHour = new Date(end.getTime() - 10 * 60_000);
    // An hourly step would overshoot the end: clamp it to the end.
    expect(lateCreditPollAt({ at: lastHour, paymentId: 'p', step: 5, deadline, windowMs })).toEqual(
      end,
    );
    expect(lateCreditPollAt({ at: end, paymentId: 'p', step: 5, deadline, windowMs })).toBeNull();
    expect(
      lateCreditPollAt({
        at: new Date(end.getTime() + 1),
        paymentId: 'p',
        step: 0,
        deadline,
        windowMs,
      }),
    ).toBeNull();
  });

  it('keeps polling only while the window is open and the payment is not closed for good', () => {
    const base = { now: new Date(T0.getTime() + HOUR), deadline: T0, windowMs: 48 * HOUR };
    for (const state of ['PENDING', 'EXPIRED', 'UNKNOWN']) {
      expect(lateCreditPollingOpen({ ...base, state })).toBe(true);
    }
    for (const state of ['CONFIRMED', 'FAILED', 'CANCELLED']) {
      expect(lateCreditPollingOpen({ ...base, state })).toBe(false);
    }
    expect(
      lateCreditPollingOpen({ ...base, state: 'EXPIRED', now: new Date(T0.getTime() + 48 * HOUR) }),
    ).toBe(false);
    expect(lateCreditPollingOpen({ ...base, state: 'EXPIRED', deadline: null })).toBe(false);
  });
});

describe('which routes may be credited', () => {
  it('only an inquiry route names a switch — TonPays, TonPays Telegram, TetraPay, Rialit and the custom gateway today', () => {
    const named = PAYMENT_GATEWAY_PROVIDERS.filter(
      (provider) => PAYMENT_GATEWAY_DESCRIPTORS[provider].lateCreditSetting !== null,
    );
    expect(named).toEqual(['TONPAYS', 'TONPAYS_TELEGRAM', 'TETRAPAY', 'RIALIT', 'CUSTOM']);
    for (const provider of named) {
      expect(PAYMENT_GATEWAY_DESCRIPTORS[provider].approval).toBe('INQUIRY');
    }
  });
});
