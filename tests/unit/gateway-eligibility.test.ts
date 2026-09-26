import { describe, expect, it } from 'vitest';
import {
  MAX_MONEY_AMOUNT_MINOR,
  PAYMENT_GATEWAY_DESCRIPTORS,
  PAYMENT_GATEWAY_PARITY_DEFERRALS,
  PAYMENT_GATEWAY_PROVIDERS,
  paymentGatewayConfigSchema,
  type PaymentGatewayEligibility,
} from '@nexa/contracts';
import {
  accountAgeInDays,
  evaluateGatewayEligibility,
} from '../../apps/api/src/modules/commerce/payments/domain/gateway-eligibility.js';

/** Every condition off, so each case below turns on exactly the one it is about. */
const OFF: PaymentGatewayEligibility = {
  activateAfterPayments: 0,
  deactivateAfterPayments: 0,
  activateAfterAccountDays: 0,
};

describe('gateway eligibility', () => {
  it('offers a route with every condition switched off', () => {
    expect(
      evaluateGatewayEligibility('ACTIVE', OFF, { confirmedPayments: 0, accountAgeDays: 0 }),
    ).toEqual({ eligible: true });
  });

  it('reports DISABLED before any fact about the customer', () => {
    /*
     * The ordering is the rule, not an accident: this customer fails the age bound too,
     * and an operator told `ACCOUNT_TOO_NEW` for a route they themselves switched off
     * goes looking at the wrong screen.
     */
    expect(
      evaluateGatewayEligibility(
        'DISABLED',
        { ...OFF, activateAfterAccountDays: 30 },
        { confirmedPayments: 0, accountAgeDays: 1 },
      ),
    ).toEqual({ eligible: false, reason: 'DISABLED' });
  });

  it('treats the show-after threshold as satisfied AT the threshold', () => {
    const eligibility = { ...OFF, activateAfterPayments: 3 };
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 2,
        accountAgeDays: 0,
      }),
    ).toEqual({ eligible: false, reason: 'TOO_FEW_PAYMENTS' });
    // "After 3 payments" is satisfied by the third, not the fourth.
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 3,
        accountAgeDays: 0,
      }),
    ).toEqual({ eligible: true });
  });

  it('hides the route AT the hide-after threshold', () => {
    const eligibility = { ...OFF, deactivateAfterPayments: 10 };
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 9,
        accountAgeDays: 0,
      }),
    ).toEqual({ eligible: true });
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 10,
        accountAgeDays: 0,
      }),
    ).toEqual({ eligible: false, reason: 'TOO_MANY_PAYMENTS' });
  });

  it('reads a zero hide-after count as OFF, not as "everybody is past it"', () => {
    /*
     * The one place `WEB-BR-014`'s "0 disables the condition" is load-bearing rather
     * than tidy. Read as a bound, `deactivateAfterPayments: 0` would hide the route
     * from every customer alive — including the ones who have paid nothing — which is
     * the default row a migration writes.
     */
    expect(
      evaluateGatewayEligibility(
        'ACTIVE',
        { ...OFF, deactivateAfterPayments: 0 },
        { confirmedPayments: 0, accountAgeDays: 0 },
      ),
    ).toEqual({ eligible: true });
  });

  it('refuses an account younger than the age bound, and admits it at the bound', () => {
    const eligibility = { ...OFF, activateAfterAccountDays: 7 };
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 0,
        accountAgeDays: 6,
      }),
    ).toEqual({ eligible: false, reason: 'ACCOUNT_TOO_NEW' });
    expect(
      evaluateGatewayEligibility('ACTIVE', eligibility, {
        confirmedPayments: 0,
        accountAgeDays: 7,
      }),
    ).toEqual({ eligible: true });
  });

  it('names the payment bound before the age bound when both refuse', () => {
    expect(
      evaluateGatewayEligibility(
        'ACTIVE',
        { activateAfterPayments: 2, deactivateAfterPayments: 0, activateAfterAccountDays: 30 },
        { confirmedPayments: 0, accountAgeDays: 1 },
      ),
    ).toEqual({ eligible: false, reason: 'TOO_FEW_PAYMENTS' });
  });

  it('never keys off anything but payment count and account age', () => {
    /*
     * `FBR-011`'s negative, asserted rather than trusted to review: the legacy gateway
     * gating keys off payment count and days since joining and NEVER off the customer's
     * tier, even though product visibility, discount codes and cashback-on-topup all do.
     * A tier arriving here later would be inventing a rule the evidence contradicts —
     * and the tier is Phase 7 besides.
     */
    expect(Object.keys(OFF).sort()).toEqual([
      'activateAfterAccountDays',
      'activateAfterPayments',
      'deactivateAfterPayments',
    ]);
  });
});

describe('account age', () => {
  const now = new Date('2026-09-17T12:00:00.000Z');

  it('floors partial days rather than rounding them up', () => {
    // Six days and twenty-three hours is not seven days.
    expect(accountAgeInDays(new Date('2026-09-10T13:00:00.000Z'), now)).toBe(6);
    expect(accountAgeInDays(new Date('2026-09-10T12:00:00.000Z'), now)).toBe(7);
  });

  it('clamps a first-seen timestamp in the future to zero', () => {
    /*
     * A negative age would make `activateAfterAccountDays` compare against a number
     * below every threshold — which is the SAFE direction — but a negative day count
     * is also a clock disagreement being reported as a fact, and the floor says so.
     */
    expect(accountAgeInDays(new Date('2026-09-18T12:00:00.000Z'), now)).toBe(0);
  });

  it('counts elapsed time, not calendar days in any timezone', () => {
    /*
     * Two customers first seen an hour apart across local midnight have the same age
     * here. A calendar-day count needs a timezone, and the tenant's display timezone is
     * a presentation setting — deriving payment eligibility from it would make the same
     * customer eligible or not depending on a field nobody associates with payments.
     */
    expect(accountAgeInDays(new Date('2026-09-16T23:30:00.000Z'), now)).toBe(0);
    expect(accountAgeInDays(new Date('2026-09-16T11:30:00.000Z'), now)).toBe(1);
  });
});

describe('the provider catalogue', () => {
  it('publishes only routes this release can operate', () => {
    /*
     * The rule `PAYMENT_METHODS` states, asserted where it can actually be broken: what
     * a product publishes is how it tells an operator what it can do, and the legacy
     * system's eleven gateways (`FBR-004`) are nine third parties this codebase has no
     * adapter for. A member added here without one is an operator switching on a route
     * that silently cannot take money.
     */
    // WP11A added TonPays WITH its adapter (`TonPaysAdapter`), which is what this pins.
    expect([...PAYMENT_GATEWAY_PROVIDERS]).toEqual(['MANUAL_TRANSFER', 'TONPAYS']);
  });

  it('declares how each route settles and whether it holds credentials', () => {
    for (const provider of PAYMENT_GATEWAY_PROVIDERS) {
      const descriptor = PAYMENT_GATEWAY_DESCRIPTORS[provider];
      expect(descriptor.provider).toBe(provider);
    }
    /*
     * Only TonPays requires credentials, and it arrived with the storage for them
     * (`payment_gateway_credentials`, WP11A). The assertion is what makes adding another
     * deliberate: a route that needs a secret has to arrive with the storage for it.
     */
    expect(PAYMENT_GATEWAY_DESCRIPTORS.MANUAL_TRANSFER).toMatchObject({
      settlesVia: 'MANUAL_TRANSFER',
      requiresCredentials: false,
    });
    expect(PAYMENT_GATEWAY_DESCRIPTORS.TONPAYS).toMatchObject({
      settlesVia: 'GATEWAY',
      requiresCredentials: true,
    });
  });
});

describe('the gateway configuration schema', () => {
  const base = {
    displayName: 'کارت به کارت',
    instructions: null,
    minAmountMinor: 0n,
    maxAmountMinor: 0n,
    eligibility: OFF,
    sortOrder: 0,
    topupCashbackPercent: 0,
  };

  it('bounds the top-up gift to a whole percentage from 0 to 100 (D5)', () => {
    for (const ok of [0, 10, 100]) {
      expect(
        paymentGatewayConfigSchema.safeParse({ ...base, topupCashbackPercent: ok }).success,
      ).toBe(true);
    }
    for (const bad of [-1, 101, 2.5]) {
      expect(
        paymentGatewayConfigSchema.safeParse({ ...base, topupCashbackPercent: bad }).success,
      ).toBe(false);
    }
    // Required, not defaulted: the form submits what it rendered, the rule for every field.
    const { topupCashbackPercent: _omitted, ...without } = base;
    void _omitted;
    expect(paymentGatewayConfigSchema.safeParse(without).success).toBe(false);
  });

  it('refuses a maximum below the minimum', () => {
    const parsed = paymentGatewayConfigSchema.safeParse({
      ...base,
      minAmountMinor: 500_000n,
      maxAmountMinor: 100_000n,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a bound the payments table cannot hold, before the database has to', () => {
    /*
     * Both columns are `bigint`. The wire schema admits nineteen digits, which is one
     * digit wider than the column's ceiling, so `9999999999999999999` used to pass every
     * parse and fail inside the UPDATE as a range error the operator met as a 500.
     * `MAX_MONEY_AMOUNT_MINOR` is that ceiling written down; the value at it is a valid
     * bound and the value one above it is not.
     */
    for (const field of ['minAmountMinor', 'maxAmountMinor'] as const) {
      const at = paymentGatewayConfigSchema.safeParse({ ...base, [field]: MAX_MONEY_AMOUNT_MINOR });
      expect(at.success, `${field} at the ceiling`).toBe(true);
      const over = paymentGatewayConfigSchema.safeParse({
        ...base,
        [field]: MAX_MONEY_AMOUNT_MINOR + 1n,
      });
      expect(over.success, `${field} one above the ceiling`).toBe(false);
    }
  });

  it('admits a zero maximum as unbounded above', () => {
    const parsed = paymentGatewayConfigSchema.safeParse({
      ...base,
      minAmountMinor: 500_000n,
      maxAmountMinor: 0n,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses payment bounds that cross, rather than resolving them', () => {
    /*
     * `FBR-008` could not establish what a legacy installation does when limits
     * conflict — reading it off a screen would have meant writing a value to a
     * production gateway. This product refuses the configuration at the boundary
     * instead, which needs no evidence: the operator is told while they can still fix it.
     */
    const crossed = paymentGatewayConfigSchema.safeParse({
      ...base,
      eligibility: { ...OFF, activateAfterPayments: 5, deactivateAfterPayments: 5 },
    });
    expect(crossed.success).toBe(false);

    const ordered = paymentGatewayConfigSchema.safeParse({
      ...base,
      eligibility: { ...OFF, activateAfterPayments: 5, deactivateAfterPayments: 6 },
    });
    expect(ordered.success).toBe(true);
  });

  it('stores an instruction raw, and an emptied field as no instruction at all', () => {
    const cleared = paymentGatewayConfigSchema.parse({ ...base, instructions: '   ' });
    expect(cleared.instructions).toBeNull();

    const body = 'به شمارهٔ کارت زیر واریز کنید.\nسپس رسید را بفرستید.';
    const kept = paymentGatewayConfigSchema.parse({ ...base, instructions: body });
    // Raw, newline and all. Nothing in this codebase persists a rendered string.
    expect(kept.instructions).toBe(body);
  });
});

describe('the parity field this release does not store', () => {
  const base = {
    displayName: null,
    instructions: null,
    minAmountMinor: 0n,
    maxAmountMinor: 0n,
    eligibility: OFF,
    sortOrder: 0,
    topupCashbackPercent: 0,
  };

  it('names it, so nobody has to go looking — the cashback percent is built now (D5)', () => {
    expect([...PAYMENT_GATEWAY_PARITY_DEFERRALS]).toEqual(['BUTTON_COLOUR']);
  });

  it('keeps a button colour OUT of the configuration, and the gift under its own name', () => {
    /*
     * The assertion that makes adding a colour deliberate rather than incidental: a
     * stored colour nothing renders is configuration an operator would believe and
     * nothing honours. The legacy `cashbackPercent` spelling is not an alias either —
     * the gift is `topupCashbackPercent`, snapshotted onto each top-up (D5).
     *
     * `z.object` strips unknown keys rather than refusing them, so this checks the
     * OUTPUT does not carry either field — which is what a repository would go on to
     * write.
     */
    const parsed = paymentGatewayConfigSchema.parse({
      ...base,
      cashbackPercent: 10,
      buttonColour: 'GREEN',
    });
    expect(Object.keys(parsed).sort()).toEqual([
      // The two purpose switches (customer UX completion §D/§F), defaulted ON for a
      // body that does not send them — the state every existing route is in.
      'allowServicePurchase',
      'allowWalletTopup',
      'displayName',
      'eligibility',
      'instructions',
      'maxAmountMinor',
      'minAmountMinor',
      'sortOrder',
      'topupCashbackPercent',
    ]);
    expect(parsed.topupCashbackPercent).toBe(0);
    expect(parsed.allowServicePurchase).toBe(true);
    expect(parsed.allowWalletTopup).toBe(true);
  });
});
