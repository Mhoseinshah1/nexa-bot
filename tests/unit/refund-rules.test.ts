import { describe, expect, it } from 'vitest';
import {
  PAYMENT_METHODS,
  REFUND_CHANNELS,
  REFUND_CONSUMING_STATES,
  REFUND_METHOD_SUPPORT,
  REFUND_STATES,
  REFUND_TERMINAL_STATES,
  REFUND_TRANSITIONS,
  refundCompletionSchema,
  refundFailureSchema,
  refundFitsWithin,
  refundMayTransition,
  refundRequestSchema,
  refundableMinor,
  type RefundState,
} from '@nexa/contracts';

/**
 * The refund's arithmetic and its state machine, tested without a database.
 *
 * These are the two rules every layer above defers to: `refundFitsWithin` is the ONE
 * place the bound is decided, and `REFUND_TRANSITIONS` is the only statement of which
 * moves exist. A service, a controller and a trigger all re-state them, and the point of
 * having them here is that all three re-state the SAME rule rather than three
 * approximations of it.
 */

describe('the refundable bound', () => {
  it('leaves the whole payment refundable when nothing is consumed', () => {
    expect(refundableMinor(250_000n, 0n)).toBe(250_000n);
  });

  it('subtracts what is already consumed', () => {
    expect(refundableMinor(250_000n, 100_000n)).toBe(150_000n);
  });

  it('never returns a negative remainder', () => {
    /*
     * Over-consumption cannot be produced by this codebase — the bound refuses it — so
     * this is about what a REPORT would say if a row were written by hand or by a future
     * path. A negative remainder rendered as money reads as "this payment owes the
     * customer nothing and also minus fifty thousand", and a caller comparing it against
     * a request would then accept one.
     */
    expect(refundableMinor(250_000n, 400_000n)).toBe(0n);
  });

  it('admits a request that exactly exhausts the remainder', () => {
    expect(
      refundFitsWithin({ paidMinor: 250_000n, consumedMinor: 200_000n, requestedMinor: 50_000n }),
    ).toBe(true);
  });

  it('refuses a request one minor unit over the remainder', () => {
    // The boundary in the unit that matters. A rule written with `<` instead of `<=`
    // fails the case above; one written against a rounded figure fails this one.
    expect(
      refundFitsWithin({ paidMinor: 250_000n, consumedMinor: 200_000n, requestedMinor: 50_001n }),
    ).toBe(false);
  });

  it('refuses a request for nothing', () => {
    // A zero refund is a row that says money moved and moves none. The table has a
    // CHECK for the same reason.
    expect(refundFitsWithin({ paidMinor: 250_000n, consumedMinor: 0n, requestedMinor: 0n })).toBe(
      false,
    );
  });

  it('refuses a negative request', () => {
    // Otherwise a "refund" of minus fifty thousand INCREASES the refundable balance,
    // which is how a bound is defeated without ever exceeding it.
    expect(
      refundFitsWithin({ paidMinor: 250_000n, consumedMinor: 0n, requestedMinor: -50_000n }),
    ).toBe(false);
  });

  it('refuses everything once the payment is fully refunded', () => {
    expect(
      refundFitsWithin({ paidMinor: 250_000n, consumedMinor: 250_000n, requestedMinor: 1n }),
    ).toBe(false);
  });

  it('adds up across partial refunds exactly', () => {
    // Three partials that together equal the payment, then one more that cannot fit.
    let consumed = 0n;
    for (const part of [100_000n, 100_000n, 50_000n]) {
      expect(
        refundFitsWithin({ paidMinor: 250_000n, consumedMinor: consumed, requestedMinor: part }),
      ).toBe(true);
      consumed += part;
    }
    expect(consumed).toBe(250_000n);
    expect(
      refundFitsWithin({ paidMinor: 250_000n, consumedMinor: consumed, requestedMinor: 1n }),
    ).toBe(false);
  });
});

describe('the refund state machine', () => {
  it('permits exactly the moves the table names', () => {
    const permitted = new Set<string>();
    for (const from of REFUND_STATES) {
      for (const to of REFUND_TRANSITIONS[from]) permitted.add(`${from}->${to}`);
    }
    for (const from of REFUND_STATES) {
      for (const to of REFUND_STATES) {
        expect(refundMayTransition(from, to), `${from}->${to}`).toBe(
          permitted.has(`${from}->${to}`),
        );
      }
    }
  });

  it('has no edge out of a terminal state', () => {
    for (const state of REFUND_TERMINAL_STATES) {
      expect(REFUND_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('refuses COMPLETED to FAILED, which would release money that has left', () => {
    expect(refundMayTransition('COMPLETED', 'FAILED')).toBe(false);
    // And the other way: a refund that was abandoned cannot be revived, because its
    // amount has already been released back to the refundable balance.
    expect(refundMayTransition('FAILED', 'COMPLETED')).toBe(false);
  });

  it('treats a state as arriving at itself as no transition', () => {
    for (const state of REFUND_STATES) {
      expect(refundMayTransition(state, state)).toBe(false);
    }
  });

  it('counts every state except FAILED against the refundable balance', () => {
    const consuming = new Set<RefundState>(REFUND_CONSUMING_STATES);
    expect([...consuming].sort()).toEqual(
      REFUND_STATES.filter((state) => state !== 'FAILED')
        .slice()
        .sort(),
    );
    /*
     * Spelled out rather than derived, and this test is what makes the difference
     * visible. `REFUND_CONSUMING_STATES` lists its members, so adding a state to
     * `REFUND_STATES` fails HERE — a deliberate stop to decide whether the new state
     * holds money — where a `!== 'FAILED'` predicate would have silently included it.
     */
    expect(consuming.has('FAILED')).toBe(false);
  });
});

describe('what each payment method refunds through', () => {
  it('declares a channel for every payment method', () => {
    for (const method of PAYMENT_METHODS) {
      const support = REFUND_METHOD_SUPPORT[method];
      expect(REFUND_CHANNELS).toContain(support.channel);
    }
  });

  it('supports the wallet and the manual transfer, and not the gateway', () => {
    expect(REFUND_METHOD_SUPPORT.WALLET).toEqual({ channel: 'WALLET_CREDIT', supported: true });
    expect(REFUND_METHOD_SUPPORT.MANUAL_TRANSFER).toEqual({
      channel: 'EXTERNAL_MANUAL',
      supported: true,
    });
    /*
     * The honest statement of this release. The channel is NAMED and the capability is
     * declared absent, which is the panel-capability rule applied to money: a capability
     * is declared after something proves it, so an unimplemented reversal is refused
     * rather than offered. A future adapter flips this in the commit that implements it.
     */
    expect(REFUND_METHOD_SUPPORT.GATEWAY).toEqual({ channel: 'PROVIDER', supported: false });
  });
});

describe('the submitted shapes', () => {
  it('takes an amount as a digit string and refuses a float or a sign', () => {
    const base = { idempotencyKey: 'k'.repeat(12), paymentId: 'p', reason: 'دلیل کافی' };
    expect(refundRequestSchema.safeParse({ ...base, amountMinor: '50000' }).success).toBe(true);
    for (const amount of ['50000.5', '-50000', '5e4', '', ' 50000', '50_000']) {
      expect(refundRequestSchema.safeParse({ ...base, amountMinor: amount }).success, amount).toBe(
        false,
      );
    }
  });

  it('requires a reason with content', () => {
    const base = { idempotencyKey: 'k'.repeat(12), paymentId: 'p', amountMinor: '1' };
    expect(refundRequestSchema.safeParse({ ...base, reason: 'ab' }).success).toBe(false);
    expect(refundRequestSchema.safeParse({ ...base, reason: '   ' }).success).toBe(false);
    expect(refundRequestSchema.safeParse({ ...base, reason: 'abc' }).success).toBe(true);
  });

  it('normalises an absent, null or blank external reference to null', () => {
    const base = { idempotencyKey: 'k'.repeat(12), note: 'واریز شد' };
    for (const value of [undefined, null, '', '   ']) {
      const parsed = refundCompletionSchema.parse(
        value === undefined ? base : { ...base, externalReference: value },
      );
      // One representation of "there is no reference", so a reader never has to tell
      // an empty string from a missing field.
      expect(parsed.externalReference).toBeNull();
    }
    expect(refundCompletionSchema.parse({ ...base, externalReference: ' 12345 ' })).toMatchObject({
      externalReference: '12345',
    });
  });

  it('takes a note on a failure, and nothing else', () => {
    const parsed = refundFailureSchema.parse({ idempotencyKey: 'k'.repeat(12), note: 'منصرف شدم' });
    expect(parsed.note).toBe('منصرف شدم');
    expect('externalReference' in parsed).toBe(false);
  });
});
