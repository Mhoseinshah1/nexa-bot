import { describe, expect, it } from 'vitest';
import {
  DISCOUNTABLE_PURPOSES,
  money,
  resellerPriceLayer,
  resellerReductionMinor,
  resellerRegisterSchema,
  resellerTierWriteSchema,
  resellerUpdateSchema,
} from '@nexa/contracts';
import type { OrderTotalsRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  catalogueScope,
  decideEntitlement,
  type EntitlementGrant,
  type EntitlementSubject,
} from '../../apps/api/src/modules/commerce/resellers/domain/entitlement';
import {
  applyResellerLayer,
  quotedResellerLayer,
  type ResellerPricingTerms,
} from '../../apps/api/src/modules/commerce/resellers/domain/reseller-pricing';

/**
 * The reseller entitlement rule and its catalogue translation
 * (`docs/wp9-reseller-audit.md` R5, R6).
 *
 * `decideEntitlement` is the rule. `catalogueScope` is the same grants translated into
 * sets the catalogue query applies in SQL. The two are separate functions, so the only
 * thing stopping the catalogue from offering what confirmation refuses — or hiding what
 * it would sell — is the agreement test below, run over every subset of a grant alphabet.
 */

const PRODUCT = 'product-1';
const OTHER_PRODUCT = 'product-2';
const CATEGORY = 'category-1';
const PANEL = 'panel-1';
const BOT = 'bot-1';

const ALPHABET: readonly EntitlementGrant[] = [
  { kind: 'OPERATION', subject: 'NEW_SERVICE' },
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: PRODUCT },
  { kind: 'PRODUCT', subject: OTHER_PRODUCT },
  { kind: 'PRODUCT', subject: null },
  { kind: 'CATEGORY', subject: CATEGORY },
  { kind: 'CATEGORY', subject: null },
  { kind: 'PANEL', subject: PANEL },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: BOT },
  { kind: 'BOT', subject: null },
];

const EVERYTHING: readonly EntitlementGrant[] = [
  { kind: 'OPERATION', subject: null },
  { kind: 'PRODUCT', subject: null },
  { kind: 'CATEGORY', subject: null },
  { kind: 'PANEL', subject: null },
  { kind: 'BOT', subject: null },
];

function subject(overrides: Partial<EntitlementSubject> = {}): EntitlementSubject {
  return {
    operation: 'NEW_SERVICE',
    productId: PRODUCT,
    categoryId: CATEGORY,
    panelId: PANEL,
    botInstanceId: BOT,
    ...overrides,
  };
}

/** What the catalogue SQL shows for one product, from the scope alone (mirrors `audienceClause`). */
function catalogueShows(grants: readonly EntitlementGrant[], s: EntitlementSubject): boolean {
  const view = catalogueScope(grants, s.botInstanceId);
  if (!view.shows) return false;
  const byProduct = view.productIds === 'ALL' || view.productIds.includes(s.productId);
  const byCategory =
    view.categoryIds === 'ALL' ||
    (s.categoryId !== null && view.categoryIds.includes(s.categoryId));
  const byPanel = view.panelIds === 'ALL' || view.panelIds.includes(s.panelId);
  return (byProduct || byCategory) && byPanel;
}

describe('decideEntitlement', () => {
  it('denies everything to a tier with no grants, naming the operation first', () => {
    expect(decideEntitlement([], subject())).toEqual({ allowed: false, dimension: 'OPERATION' });
  });

  it('allows everything to a tier granting every subject of every kind', () => {
    for (const operation of DISCOUNTABLE_PURPOSES) {
      expect(decideEntitlement(EVERYTHING, subject({ operation }))).toEqual({ allowed: true });
      expect(
        decideEntitlement(
          EVERYTHING,
          subject({ operation, categoryId: null, botInstanceId: null }),
        ),
      ).toEqual({ allowed: true });
    }
  });

  it('refuses each dimension alone when only that grant is missing', () => {
    const without = (kind: EntitlementGrant['kind']) => EVERYTHING.filter((g) => g.kind !== kind);
    expect(decideEntitlement(without('OPERATION'), subject())).toEqual({
      allowed: false,
      dimension: 'OPERATION',
    });
    // The catalogue dimension is PRODUCT or CATEGORY: removing one leaves the other.
    expect(
      decideEntitlement(
        EVERYTHING.filter((g) => g.kind !== 'PRODUCT' && g.kind !== 'CATEGORY'),
        subject(),
      ),
    ).toEqual({ allowed: false, dimension: 'CATALOGUE' });
    expect(decideEntitlement(without('PANEL'), subject())).toEqual({
      allowed: false,
      dimension: 'PANEL',
    });
    expect(decideEntitlement(without('BOT'), subject())).toEqual({
      allowed: false,
      dimension: 'BOT',
    });
  });

  it('grants a named operation and nothing else', () => {
    const grants = [
      { kind: 'OPERATION', subject: 'RENEW' },
      ...EVERYTHING.filter((g) => g.kind !== 'OPERATION'),
    ] as const;
    expect(decideEntitlement(grants, subject({ operation: 'RENEW' }))).toEqual({
      allowed: true,
    });
    expect(decideEntitlement(grants, subject({ operation: 'NEW_SERVICE' }))).toEqual({
      allowed: false,
      dimension: 'OPERATION',
    });
  });

  it('lets a named category through only for a product in it, and never an uncategorised one', () => {
    const grants: EntitlementGrant[] = [
      { kind: 'OPERATION', subject: null },
      { kind: 'CATEGORY', subject: CATEGORY },
      { kind: 'PANEL', subject: null },
      { kind: 'BOT', subject: null },
    ];
    expect(decideEntitlement(grants, subject())).toEqual({ allowed: true });
    expect(decideEntitlement(grants, subject({ categoryId: 'category-2' }))).toEqual({
      allowed: false,
      dimension: 'CATALOGUE',
    });
    expect(decideEntitlement(grants, subject({ categoryId: null }))).toEqual({
      allowed: false,
      dimension: 'CATALOGUE',
    });
  });

  it('lets a request through no bot pass only a grant of every bot', () => {
    const named = [
      ...EVERYTHING.filter((g) => g.kind !== 'BOT'),
      { kind: 'BOT', subject: BOT },
    ] as const;
    expect(decideEntitlement(named, subject({ botInstanceId: null }))).toEqual({
      allowed: false,
      dimension: 'BOT',
    });
    expect(decideEntitlement(named, subject({ botInstanceId: 'bot-2' }))).toEqual({
      allowed: false,
      dimension: 'BOT',
    });
    expect(decideEntitlement(named, subject())).toEqual({ allowed: true });
  });
});

describe('catalogueScope agrees with decideEntitlement', () => {
  const subjects: EntitlementSubject[] = [];
  for (const productId of [PRODUCT, 'product-3'])
    for (const categoryId of [CATEGORY, 'category-2', null])
      for (const panelId of [PANEL, 'panel-2'])
        for (const botInstanceId of [BOT, 'bot-2', null])
          subjects.push({
            operation: 'NEW_SERVICE',
            productId,
            categoryId,
            panelId,
            botInstanceId,
          });

  it(`shows exactly what a new purchase would be allowed, over all ${2 ** ALPHABET.length} grant sets`, () => {
    let checked = 0;
    for (let mask = 0; mask < 2 ** ALPHABET.length; mask += 1) {
      const grants = ALPHABET.filter((_, i) => (mask & (1 << i)) !== 0);
      for (const s of subjects) {
        const rule = decideEntitlement(grants, s).allowed;
        const shown = catalogueShows(grants, s);
        if (rule !== shown) {
          throw new Error(
            `disagreement: grants=${JSON.stringify(grants)} subject=${JSON.stringify(s)} rule=${rule} shown=${shown}`,
          );
        }
        checked += 1;
      }
    }
    expect(checked).toBe(2 ** ALPHABET.length * subjects.length);
  });

  it('shows nothing when the tier grants no new purchase, whatever else it grants', () => {
    const grants = EVERYTHING.filter((g) => g.kind !== 'OPERATION').concat({
      kind: 'OPERATION',
      subject: 'RENEW',
    });
    expect(catalogueScope(grants, BOT).shows).toBe(false);
  });
});

describe('the reseller price layer', () => {
  function base(amount: bigint): OrderTotalsRecord {
    return {
      subtotal: money(amount, 'IRT'),
      discount: money(0n, 'IRT'),
      total: money(amount, 'IRT'),
      currency: 'IRT',
      quote: {
        productId: PRODUCT,
        quotedAt: '2026-09-01T12:00:00.000Z',
        currency: 'IRT',
        finalAmount: money(amount, 'IRT'),
        trace: [
          {
            step: 'BASE_PRICE',
            effect: 'REPLACES',
            ruleId: null,
            ruleLabel: 'base',
            amountBefore: money(amount, 'IRT'),
            amountAfter: money(amount, 'IRT'),
          },
        ],
      },
    } as unknown as OrderTotalsRecord;
  }

  function terms(
    layer: 'LIST' | 'TIER' | 'OVERRIDE',
    percent: number | null,
  ): ResellerPricingTerms {
    return {
      resellerId: 'reseller-row',
      customerId: 'customer',
      tierId: 'tier-1',
      tierName: 'Gold',
      layer,
      percent,
    };
  }

  it('takes the override over the tier, and the tier when the override defers', () => {
    expect(
      resellerPriceLayer(
        { mode: 'PERCENTAGE_DISCOUNT', percent: 10 },
        { mode: 'PERCENTAGE_DISCOUNT', percent: 25 },
      ),
    ).toEqual({ layer: 'OVERRIDE', percent: 25 });
    expect(
      resellerPriceLayer(
        { mode: 'PERCENTAGE_DISCOUNT', percent: 10 },
        { mode: 'TIER', percent: null },
      ),
    ).toEqual({ layer: 'TIER', percent: 10 });
    expect(
      resellerPriceLayer(
        { mode: 'PERCENTAGE_DISCOUNT', percent: 10 },
        { mode: 'LIST_PRICE', percent: null },
      ),
    ).toEqual({ layer: 'OVERRIDE', percent: null });
    // The list price by the reseller's own override is still the OVERRIDE layer: the
    // snapshot records who decided it. The tier's list price is the LIST layer.
    expect(
      resellerPriceLayer({ mode: 'LIST_PRICE', percent: null }, { mode: 'TIER', percent: null }),
    ).toEqual({ layer: 'LIST', percent: null });
  });

  it('rounds the reduction in the buyer’s favour and never past the whole', () => {
    expect(resellerReductionMinor(10_005n, 10)).toBe(1_001n);
    expect(resellerReductionMinor(10_000n, null)).toBe(0n);
    expect(resellerReductionMinor(0n, 50)).toBe(0n);
  });

  /*
   * PR #69 review, F4. A reseller cost of zero is an order nobody can pay: the payment and
   * ledger amount checks refuse a zero amount at settlement, after the customer confirmed.
   * The reduction is capped at `subtotal − 1`, so a positive subtotal keeps one minor unit.
   */
  it('never takes a positive subtotal below one minor unit', () => {
    // 1% of 1 rounds its reduction UP to 1, which was the whole subtotal.
    expect(1n - resellerReductionMinor(1n, 1)).toBe(1n);
    expect(1n - resellerReductionMinor(1n, 99)).toBe(1n);
    // 99% of 100 is exactly 99: the floor is not what decides it.
    expect(100n - resellerReductionMinor(100n, 99)).toBe(1n);
    // 99% of 101 rounds its reduction up to 100, leaving 1.
    expect(101n - resellerReductionMinor(101n, 99)).toBe(1n);
    // A rate the write schemas refuse but the database still stores.
    expect(10_000n - resellerReductionMinor(10_000n, 100)).toBe(1n);
    // Below the floor nothing changes.
    expect(100n - resellerReductionMinor(100n, 98)).toBe(2n);
  });

  it('keeps that unit through the pricing layer, as a step with a positive cost', () => {
    const priced = applyResellerLayer(base(1n), terms('TIER', 1));
    // Nothing is taken off, so no step fires, and the cost is the one unit.
    expect(priced.total.amountMinor).toBe(1n);
    expect(quotedResellerLayer(priced.quote.trace)).toBeNull();
    const deep = applyResellerLayer(base(100n), terms('TIER', 99));
    expect(deep.subtotal.amountMinor).toBe(1n);
    expect(deep.total.amountMinor).toBe(1n);
  });

  it('refuses a 100% rate in every reseller write schema, and accepts 99', () => {
    const id = '01900000-0000-7000-8000-00000000abcd';
    const tier = (discountPercentage: number) =>
      resellerTierWriteSchema.safeParse({
        idempotencyKey: 'a-long-enough-key',
        name: 'Gold',
        pricingMode: 'PERCENTAGE_DISCOUNT',
        discountPercentage,
        creditLimit: { amount: '0', currency: 'IRT' },
      }).success;
    const shape = { tierId: id, pricingMode: 'PERCENTAGE_DISCOUNT', creditLimit: null };
    const register = (discountPercentage: number) =>
      resellerRegisterSchema.safeParse({
        idempotencyKey: 'a-long-enough-key',
        customerId: id,
        ...shape,
        discountPercentage,
      }).success;
    const update = (discountPercentage: number) =>
      resellerUpdateSchema.safeParse({
        idempotencyKey: 'a-long-enough-key',
        status: 'ACTIVE',
        ...shape,
        discountPercentage,
      }).success;
    for (const accepts of [tier, register, update]) {
      expect(accepts(99)).toBe(true);
      expect(accepts(100)).toBe(false);
    }
  });

  it('replaces the subtotal with the tier cost, as one TIER_PRICE step, and no discount', () => {
    const priced = applyResellerLayer(base(10_005n), terms('TIER', 10));
    expect(priced.subtotal.amountMinor).toBe(9_004n);
    expect(priced.total.amountMinor).toBe(9_004n);
    expect(priced.discount.amountMinor).toBe(0n);
    expect(priced.quote.finalAmount.amountMinor).toBe(9_004n);
    expect(quotedResellerLayer(priced.quote.trace)).toEqual({
      step: 'TIER_PRICE',
      ruleId: 'tier-1',
      cost: 9_004n,
    });
  });

  it('names the reseller row, not the tier, on an override step', () => {
    const priced = applyResellerLayer(base(10_000n), terms('OVERRIDE', 25));
    expect(quotedResellerLayer(priced.quote.trace)).toEqual({
      step: 'USER_OVERRIDE',
      ruleId: 'reseller-row',
      cost: 7_500n,
    });
  });

  it('adds no step for the list layer or a zero reduction', () => {
    const list = base(10_000n);
    expect(applyResellerLayer(list, terms('LIST', null))).toBe(list);
    expect(applyResellerLayer(list, terms('TIER', 0))).toBe(list);
    expect(quotedResellerLayer(list.quote.trace)).toBeNull();
  });
});
