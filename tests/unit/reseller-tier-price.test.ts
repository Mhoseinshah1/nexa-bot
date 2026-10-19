import { describe, expect, it } from 'vitest';
import {
  MAX_ORDER_QUANTITY,
  RESELLER_PRICING_MODES,
  RESELLER_TIER_PRICE_PURPOSES,
  isResellerTierPricePurpose,
  money,
  resellerPriceLayer,
  resellerTierProductPricesWriteSchema,
  resellerTierWriteSchema,
} from '@nexa/contracts';
import type { OrderTotalsRecord } from '../../apps/api/src/modules/commerce/orders/application/ports';
import {
  applyResellerLayer,
  decideTierPrice,
  quotedResellerLayer,
  resellerCostMinor,
  type ResellerPricingTerms,
} from '../../apps/api/src/modules/commerce/resellers/domain/reseller-pricing';

/**
 * Round 4 PR-G — a reseller tier's fixed price per product (`FIXED_PRICE_TABLE`).
 *
 * The pure half of the rule: what a table row decides (`decideTierPrice`), what the layer
 * charges (`resellerCostMinor`, the ONE statement the quote, the confirmation and the
 * catalogue share) and that the layer REPLACES the subtotal as a `TIER_PRICE` step and is
 * never recorded as a discount (`applyResellerLayer`). The integration half — the quote, the
 * refusal, the fallback and the price changed between quote and confirmation — is
 * `tests/integration/reseller-tier-prices.test.ts`.
 */

const PRODUCT = '01900000-0000-7000-8000-0000000000aa';

function base(amount: bigint): OrderTotalsRecord {
  return {
    subtotal: money(amount, 'IRT'),
    discount: money(0n, 'IRT'),
    total: money(amount, 'IRT'),
    currency: 'IRT',
    quote: {
      productId: PRODUCT,
      quotedAt: '2026-10-19T12:00:00.000Z',
      currency: 'IRT',
      finalAmount: money(amount, 'IRT'),
      trace: [
        {
          step: 'BASE_PRICE',
          effect: 'REPLACES',
          ruleId: null,
          ruleLabel: 'base',
          amountBefore: money(0n, 'IRT'),
          amountAfter: money(amount, 'IRT'),
        },
      ],
    },
  } as unknown as OrderTotalsRecord;
}

function table(price: bigint | null, currency: 'IRT' | 'IRR' = 'IRT'): ResellerPricingTerms {
  return {
    resellerId: 'reseller-row',
    customerId: 'customer',
    tierId: 'tier-silver',
    tierName: 'نمایندگی نقره‌ای',
    layer: price === null ? 'LIST' : 'TIER',
    percent: null,
    fixedPrice: price === null ? null : money(price, currency),
  };
}

describe('a tier price table (Round 4 PR-G)', () => {
  it('declares the mode in the contract, as the TIER layer with no percent', () => {
    expect(RESELLER_PRICING_MODES).toContain('FIXED_PRICE_TABLE');
    expect(
      resellerPriceLayer(
        { mode: 'FIXED_PRICE_TABLE', percent: null },
        { mode: 'TIER', percent: null },
      ),
    ).toEqual({ layer: 'TIER', percent: null });
    // A reseller's own override still replaces the tier's pricing, table included.
    expect(
      resellerPriceLayer(
        { mode: 'FIXED_PRICE_TABLE', percent: null },
        { mode: 'LIST_PRICE', percent: null },
      ),
    ).toEqual({ layer: 'OVERRIDE', percent: null });
  });

  it('prices products only: buying and renewing, never an add-on', () => {
    expect([...RESELLER_TIER_PRICE_PURPOSES]).toEqual(['NEW_SERVICE', 'RENEW']);
    for (const addon of ['ADD_TRAFFIC', 'ADD_TIME', 'ADD_DEVICES', 'CHANGE_LOCATION']) {
      expect(isResellerTierPricePurpose(addon)).toBe(false);
    }
  });

  it('decides a row: priced, else the list when the tier allows it, else not sellable', () => {
    expect(decideTierPrice(money(800n, 'IRT'), 'IRT', false)).toEqual({
      kind: 'PRICED',
      price: money(800n, 'IRT'),
    });
    expect(decideTierPrice(null, 'IRT', false)).toEqual({ kind: 'UNSELLABLE' });
    expect(decideTierPrice(null, 'IRT', true)).toEqual({ kind: 'LIST' });
  });

  it('reads a row in another currency as no price — never converted, never compared', () => {
    expect(decideTierPrice(money(800n, 'IRR'), 'IRT', false)).toEqual({ kind: 'UNSELLABLE' });
    expect(decideTierPrice(money(800n, 'IRR'), 'IRT', true)).toEqual({ kind: 'LIST' });
  });

  it('charges the table price, and the list when the table price is not below it', () => {
    expect(resellerCostMinor(1_000_000n, table(800_000n))).toBe(800_000n);
    expect(resellerCostMinor(1_000_000n, table(1_000_000n))).toBe(1_000_000n);
    // Above list: the reseller never pays more than an ordinary customer.
    expect(resellerCostMinor(1_000_000n, table(1_200_000n))).toBe(1_000_000n);
    // The list layer charges the list.
    expect(resellerCostMinor(1_000_000n, table(null))).toBe(1_000_000n);
  });

  it('prices one unit, because an order line is one unit', () => {
    // `resellerCostMinor` multiplies by MAX_ORDER_QUANTITY. If a line ever carries more
    // units, the quantity has to reach the layer — this pins the assumption it states.
    expect(MAX_ORDER_QUANTITY).toBe(1);
  });

  it('REPLACES the subtotal with the tier price, as one TIER_PRICE step, with no discount', () => {
    const priced = applyResellerLayer(base(1_000_000n), table(800_000n));
    expect(priced.subtotal).toEqual(money(800_000n, 'IRT'));
    expect(priced.total).toEqual(money(800_000n, 'IRT'));
    expect(priced.discount, 'a margin is never a discount').toEqual(money(0n, 'IRT'));
    expect(priced.quote.finalAmount).toEqual(money(800_000n, 'IRT'));
    const step = priced.quote.trace[1];
    expect(step).toMatchObject({
      step: 'TIER_PRICE',
      effect: 'REPLACES',
      ruleId: 'tier-silver',
      ruleLabel: 'نمایندگی نقره‌ای',
    });
    expect(step?.amountBefore).toEqual(money(1_000_000n, 'IRT'));
    expect(step?.amountAfter).toEqual(money(800_000n, 'IRT'));
    expect(quotedResellerLayer(priced.quote.trace)).toEqual({
      step: 'TIER_PRICE',
      ruleId: 'tier-silver',
      cost: 800_000n,
    });
  });

  it('keeps every amount a bigint with its currency', () => {
    const priced = applyResellerLayer(base(1_000_000n), table(800_000n));
    for (const amount of [
      priced.subtotal,
      priced.discount,
      priced.total,
      priced.quote.finalAmount,
    ]) {
      expect(typeof amount.amountMinor).toBe('bigint');
      expect(amount.currency).toBe('IRT');
    }
  });

  it('adds no step when the table price takes nothing off the list', () => {
    const list = base(1_000_000n);
    expect(applyResellerLayer(list, table(1_000_000n))).toBe(list);
    expect(applyResellerLayer(list, table(5_000_000n))).toBe(list);
  });

  it('refuses to apply a table price in a currency other than the list price', () => {
    expect(() => applyResellerLayer(base(1_000_000n), table(800_000n, 'IRR'))).toThrow(
      /currency of the list price/u,
    );
  });

  it('accepts the price-table mode and its option on the tier write, off by default', () => {
    const parsed = resellerTierWriteSchema.parse({
      idempotencyKey: 'a-long-enough-key',
      name: 'نمایندگی نقره‌ای',
      pricingMode: 'FIXED_PRICE_TABLE',
      discountPercentage: null,
      creditLimit: { amount: '0', currency: 'IRT' },
    });
    expect(parsed.unpricedListFallback).toBe(false);
    // A price table carries no percentage.
    expect(
      resellerTierWriteSchema.safeParse({
        idempotencyKey: 'a-long-enough-key',
        name: 'x',
        pricingMode: 'FIXED_PRICE_TABLE',
        discountPercentage: 10,
        creditLimit: { amount: '0', currency: 'IRT' },
      }).success,
    ).toBe(false);
  });

  it('accepts a price as positive whole minor units only, each product once', () => {
    const write = (prices: unknown) =>
      resellerTierProductPricesWriteSchema.safeParse({
        idempotencyKey: 'a-long-enough-key',
        prices,
      }).success;
    const p = '01900000-0000-7000-8000-0000000000ab';
    expect(write([{ productId: p, price: { amount: '800000', currency: 'IRT' } }])).toBe(true);
    expect(write([{ productId: p, price: null }])).toBe(true);
    expect(write([{ productId: p, price: { amount: '0', currency: 'IRT' } }])).toBe(false);
    expect(write([{ productId: p, price: { amount: '1.5', currency: 'IRT' } }])).toBe(false);
    expect(write([{ productId: p, price: { amount: '-1', currency: 'IRT' } }])).toBe(false);
    expect(
      write([
        { productId: p, price: null },
        { productId: p, price: { amount: '1', currency: 'IRT' } },
      ]),
    ).toBe(false);
    expect(write([])).toBe(false);
  });
});
