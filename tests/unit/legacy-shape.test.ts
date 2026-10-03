import { describe, expect, it } from 'vitest';
import { BYTES_PER_GB, money } from '@nexa/contracts';
import {
  LEGACY_SHAPE_KEY_VERSION,
  keyOfLegacyShape,
  legacyHiddenProductTitle,
  legacyShapeKey,
  resolveCurrentTariff,
  type LegacyShapeInput,
  type TariffCandidate,
} from '../../apps/api/src/modules/commerce/catalog/application/legacy-shape';
import { legacyShapeAdoptable } from '../../apps/api/src/modules/commerce/catalog/application/legacy-product.service';

/**
 * Program Item 14: the canonical legacy shape key and the current-tariff rule
 * (`docs/legacy-migration/hidden-legacy-products.md` §2, §3). Pure, so every rule here
 * is pinned without a database.
 */

const base: LegacyShapeInput = {
  codePanel: 'bac6',
  volume: '10',
  serviceTime: '30',
  timeUnit: null,
  isCustom: 0,
};

const keyOf = (input: Partial<LegacyShapeInput>): string => {
  const result = legacyShapeKey({ ...base, ...input });
  if (!result.ok) throw new Error(`expected a key, got ${result.reason}`);
  return result.key;
};

describe('legacyShapeKey', () => {
  it('is deterministic and versioned', () => {
    expect(keyOf({})).toBe(keyOf({}));
    expect(keyOf({})).toBe(
      `${LEGACY_SHAPE_KEY_VERSION}:["bac6","${String(10n * BYTES_PER_GB)}",30,0]`,
    );
  });

  it('has no price input at all: two invoices of one shape at two prices are one shape', () => {
    // `price_product` is not a field of the input; an object carrying one is the same key.
    const withPrice = { ...base, price_product: '29000' } as LegacyShapeInput;
    const otherPrice = { ...base, price_product: '57000' } as LegacyShapeInput;
    const a = legacyShapeKey(withPrice);
    const b = legacyShapeKey(otherPrice);
    expect(a.ok && b.ok && a.key === b.key).toBe(true);
    expect(a.ok && a.key.includes('29000')).toBe(false);
  });

  it('canonicalises spellings that mean the same tariff', () => {
    expect(keyOf({ volume: 10, serviceTime: 30 })).toBe(keyOf({}));
    expect(keyOf({ volume: ' 10 ', serviceTime: ' 30 ' })).toBe(keyOf({}));
    expect(keyOf({ volume: '10.0' })).toBe(keyOf({}));
    for (const unit of ['', ' ', 'day', 'DAY', 'days', 'd', ' Days ']) {
      expect(keyOf({ timeUnit: unit }), unit).toBe(keyOf({}));
    }
    expect(keyOf({ codePanel: '  bac6 ' })).toBe(keyOf({}));
    expect(keyOf({ isCustom: '0' })).toBe(keyOf({ isCustom: false }));
  });

  it('separates every tariff dimension', () => {
    const keys = new Set([
      keyOf({}),
      keyOf({ codePanel: 'other' }),
      keyOf({ codePanel: null }),
      keyOf({ volume: '20' }),
      keyOf({ serviceTime: '60' }),
      keyOf({ isCustom: 1 }),
    ]);
    expect(keys.size).toBe(6);
  });

  it('treats a missing and an empty panel code as the same missing panel', () => {
    expect(keyOf({ codePanel: null })).toBe(keyOf({ codePanel: '' }));
    expect(keyOf({ codePanel: '   ' })).toBe(keyOf({ codePanel: null }));
    const result = legacyShapeKey({ ...base, codePanel: '' });
    expect(result.ok && result.shape.legacyCodePanel).toBeNull();
  });

  it('keeps the panel code exactly, without guessing that two spellings are one panel', () => {
    expect(keyOf({ codePanel: 'BAC6' })).not.toBe(keyOf({ codePanel: 'bac6' }));
  });

  it('accepts a custom shape and records it as custom', () => {
    const result = legacyShapeKey({ ...base, isCustom: '1', volume: '17.5', serviceTime: '45' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shape).toEqual({
      legacyCodePanel: 'bac6',
      trafficBytes: (1750n * BYTES_PER_GB + 50n) / 100n,
      durationDays: 45,
      isCustom: true,
    });
    expect(keyOfLegacyShape(result.shape)).toBe(result.key);
  });

  it.each([
    [{ timeUnit: 'month' }, 'TIME_UNIT_UNKNOWN'],
    [{ timeUnit: 'hour' }, 'TIME_UNIT_UNKNOWN'],
    [{ timeUnit: 'ماه' }, 'TIME_UNIT_UNKNOWN'],
    [{ volume: '0' }, 'VOLUME_ZERO'],
    [{ volume: 0 }, 'VOLUME_ZERO'],
    [{ volume: null }, 'VOLUME_INVALID'],
    [{ volume: '-1' }, 'VOLUME_INVALID'],
    [{ volume: '1e3' }, 'VOLUME_INVALID'],
    [{ volume: '10.125' }, 'VOLUME_INVALID'],
    [{ volume: 'ten' }, 'VOLUME_INVALID'],
    [{ serviceTime: '0' }, 'DURATION_ZERO'],
    [{ serviceTime: null }, 'DURATION_INVALID'],
    [{ serviceTime: '30.5' }, 'DURATION_INVALID'],
    [{ serviceTime: '3651' }, 'DURATION_INVALID'],
    [{ serviceTime: -5 }, 'DURATION_INVALID'],
    [{ isCustom: 2 }, 'IS_CUSTOM_INVALID'],
    [{ isCustom: null }, 'IS_CUSTOM_INVALID'],
    [{ codePanel: 'a\nb' }, 'CODE_PANEL_INVALID'],
    [{ codePanel: 'x'.repeat(201) }, 'CODE_PANEL_INVALID'],
  ] as const)('refuses %o as %s rather than guessing', (input, reason) => {
    expect(legacyShapeKey({ ...base, ...input })).toEqual({ ok: false, reason });
  });

  it('titles the hidden product from the shape, not from any price', () => {
    const result = legacyShapeKey({ ...base, isCustom: 1 });
    if (!result.ok) throw new Error('expected a key');
    const title = legacyHiddenProductTitle(result.shape);
    expect(title).toContain('10 GB');
    expect(title).toContain('30');
    expect(title.length).toBeLessThanOrEqual(120);
  });
});

describe('resolveCurrentTariff', () => {
  const shape = { trafficBytes: 10n * BYTES_PER_GB, durationDays: 30 };
  const product = (id: string, over: Partial<TariffCandidate> = {}): TariffCandidate => ({
    id,
    status: 'ACTIVE',
    audience: 'EVERYONE',
    durationDays: 30,
    trafficBytes: 10n * BYTES_PER_GB,
    price: money(35_000n, 'IRT'),
    ...over,
  });

  it('takes the one current public price, not any historical one', () => {
    expect(resolveCurrentTariff(shape, [product('b'), product('a')], 'IRT')).toEqual({
      kind: 'MATCHED',
      price: money(35_000n, 'IRT'),
      sourceProductId: 'a',
    });
  });

  it('has no tariff when nothing public, active and priced sells this shape', () => {
    const none = [
      product('a', { status: 'INACTIVE' }),
      product('b', { audience: 'HIDDEN' }),
      product('c', { audience: 'RESELLERS_ONLY' }),
      product('d', { price: null }),
      product('e', { price: money(35n, 'USD' as never) }),
      product('f', { durationDays: 31 }),
      product('g', { trafficBytes: 11n * BYTES_PER_GB }),
    ];
    expect(resolveCurrentTariff(shape, none, 'IRT')).toEqual({ kind: 'NO_CURRENT_TARIFF' });
    expect(resolveCurrentTariff(shape, [], 'IRT')).toEqual({ kind: 'NO_CURRENT_TARIFF' });
  });

  it('never takes a reseller-only price, even when it is the only match', () => {
    expect(
      resolveCurrentTariff(shape, [product('a', { audience: 'RESELLERS_ONLY' })], 'IRT').kind,
    ).toBe('NO_CURRENT_TARIFF');
  });

  it('refuses to choose between two current prices', () => {
    expect(
      resolveCurrentTariff(
        shape,
        [product('a'), product('b', { price: money(40_000n, 'IRT') })],
        'IRT',
      ),
    ).toEqual({ kind: 'AMBIGUOUS_TARIFF' });
  });
});

describe('legacyShapeAdoptable', () => {
  const shape = {
    id: 's',
    shapeKey: 'k',
    legacyCodePanel: null,
    trafficBytes: 1n,
    durationDays: 30,
    isCustom: false,
    productId: 'p',
    tariffStatus: 'RESOLVED',
    unresolvedReason: null,
    resolution: 'MATCHED_PUBLIC_PRODUCT',
    tariffSourceProductId: 'q',
    resolvedAt: new Date(0),
    createdAt: new Date(0),
    updatedAt: new Date(0),
  } as never;
  const product = {
    id: 'p',
    status: 'ACTIVE',
    audience: 'HIDDEN',
    categoryId: null,
    price: money(1n, 'IRT'),
  } as never;

  it('admits only a resolved shape whose hidden product is live and priced', () => {
    expect(legacyShapeAdoptable(shape, product)).toBe(true);
    expect(legacyShapeAdoptable(null, product)).toBe(false);
    expect(legacyShapeAdoptable(shape, null)).toBe(false);
    const unresolved = { ...(shape as object), tariffStatus: 'UNRESOLVED' } as never;
    expect(legacyShapeAdoptable(unresolved, product)).toBe(false);
    for (const over of [
      { status: 'INACTIVE' },
      { audience: 'EVERYONE' },
      { categoryId: 'c' },
      { price: null },
      { id: 'other' },
    ]) {
      expect(
        legacyShapeAdoptable(shape, { ...(product as object), ...over } as never),
        JSON.stringify(over),
      ).toBe(false);
    }
  });
});
