import { describe, expect, it } from 'vitest';
import {
  locationChangeWindow,
  locationReached,
  money,
  serviceLocationWriteSchema,
  type PanelId,
  type ProductId,
  type ServiceLocationId,
} from '@nexa/contracts';
import {
  currentLocation,
  resolvedTargets,
} from '../../apps/api/src/modules/commerce/locations/application/location-change-policy';
import type { ServiceLocationRecord } from '../../apps/api/src/modules/commerce/locations/application/ports';
import { quoteLocationChange } from '../../apps/api/src/modules/commerce/orders/application/order-pricing';

/**
 * WP-A6's pure rules, as tables: the cooldown and rolling limit, the absolute-target
 * verdict a lost move is settled by, where a service is, and which configured row applies
 * to it. Each case names the one rule it pins.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = new Date('2026-09-28T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const NONE = { cooldownHours: null, maxChanges: null, periodDays: null };

describe('locationChangeWindow', () => {
  it('allows anything with no limits and no history', () => {
    expect(locationChangeWindow(NONE, [], NOW)).toEqual({ ok: true });
    expect(locationChangeWindow(NONE, [ago(1)], NOW)).toEqual({ ok: true });
  });

  it('runs the cooldown from the LATEST counted change, half-open at its end', () => {
    const limits = { ...NONE, cooldownHours: 24 };
    expect(locationChangeWindow(limits, [ago(30 * DAY), ago(23 * HOUR)], NOW)).toEqual({
      ok: false,
      reason: 'COOLDOWN',
    });
    // Exactly the cooldown later is allowed again.
    expect(locationChangeWindow(limits, [ago(24 * HOUR)], NOW)).toEqual({ ok: true });
  });

  it('counts the rolling period inclusively at its start, and refuses at the maximum', () => {
    const limits = { cooldownHours: null, maxChanges: 2, periodDays: 30 };
    expect(locationChangeWindow(limits, [ago(1 * DAY)], NOW)).toEqual({ ok: true });
    expect(locationChangeWindow(limits, [ago(1 * DAY), ago(30 * DAY)], NOW)).toEqual({
      ok: false,
      reason: 'LIMIT',
    });
    // One just outside the window no longer counts.
    expect(locationChangeWindow(limits, [ago(1 * DAY), ago(30 * DAY + 1)], NOW)).toEqual({
      ok: true,
    });
  });
});

describe('locationReached', () => {
  it('is equality, and an account in no nameable location reaches nothing', () => {
    expect(locationReached('nl', 'nl')).toBe(true);
    expect(locationReached('nl', 'de')).toBe(false);
    expect(locationReached('nl', null)).toBe(false);
    expect(locationReached('nl', 'NL')).toBe(false);
  });
});

function row(overrides: Partial<ServiceLocationRecord>): ServiceLocationRecord {
  return {
    id: overrides.locationKey ?? 'id',
    tenantId: 't',
    panelId: 'p' as PanelId,
    productId: null,
    locationKey: 'nl',
    label: 'هلند',
    initial: false,
    enabled: true,
    price: money(30_000n, 'IRT'),
    limits: NONE,
    sortOrder: 0,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as ServiceLocationRecord;
}

describe('where a service is', () => {
  const initial = row({ locationKey: 'de', label: 'آلمان', initial: true });

  it('is its own recorded location first', () => {
    expect(currentLocation({ locationKey: 'fi', locationLabel: 'فنلاند' }, [initial])).toEqual({
      key: 'fi',
      label: 'فنلاند',
    });
  });

  it("is its panel's initial location when it never moved, and unknown with none", () => {
    expect(currentLocation({ locationKey: null, locationLabel: null }, [initial])).toEqual({
      key: 'de',
      label: 'آلمان',
    });
    expect(currentLocation({ locationKey: null, locationLabel: null }, [row({})])).toBeNull();
  });
});

describe('which configured row applies', () => {
  const product = 'prod-a' as ProductId;

  it('lets a product row win over the panel-wide one for its key, whatever its switch', () => {
    const wide = row({ id: 'wide' as ServiceLocationId });
    const scoped = row({ id: 'scoped' as ServiceLocationId, productId: product, enabled: false });
    expect(resolvedTargets([wide, scoped], product).map((one) => one.id)).toEqual(['scoped']);
    // Another product's services still see the panel-wide row.
    expect(resolvedTargets([wide, scoped], 'prod-b').map((one) => one.id)).toEqual(['wide']);
  });

  it("never lets another product's row apply", () => {
    const other = row({ id: 'other' as ServiceLocationId, productId: 'prod-b' as ProductId });
    expect(resolvedTargets([other], product)).toEqual([]);
  });
});

describe('the paid quote', () => {
  it('names the configured location on its base step, and refuses a free one', () => {
    const quote = quoteLocationChange({ id: 'loc', price: money(30_000n, 'IRT') }, NOW);
    expect(quote.total).toEqual(money(30_000n, 'IRT'));
    expect(quote.quote.trace[0]?.ruleId).toBe('loc');
    expect(() => quoteLocationChange({ id: 'loc', price: money(0n, 'IRT') }, NOW)).toThrow();
  });
});

describe('the operator write shape', () => {
  const base = {
    idempotencyKey: 'key-12345678',
    panelId: '0191f4a0-9e77-7d18-8c03-2b9d4e5a1f61',
    productId: null,
    locationKey: 'nl',
    label: 'هلند',
    initial: false,
    enabled: true,
    priceAmount: '0',
    priceCurrency: 'IRT',
    cooldownHours: null,
    maxChanges: null,
    periodDays: null,
    sortOrder: 0,
  };

  it('accepts free as an explicit zero, and refuses an enabled location with no price', () => {
    expect(serviceLocationWriteSchema.safeParse(base).success).toBe(true);
    expect(
      serviceLocationWriteSchema.safeParse({ ...base, priceAmount: null, priceCurrency: null })
        .success,
    ).toBe(false);
  });

  it('refuses a price past the largest amount this system holds (Codex #1, PR #101)', () => {
    expect(
      serviceLocationWriteSchema.safeParse({ ...base, priceAmount: '9223372036854775807' }).success,
    ).toBe(true);
    expect(
      serviceLocationWriteSchema.safeParse({ ...base, priceAmount: '9223372036854775808' }).success,
    ).toBe(false);
  });

  it('refuses a malformed price as an issue, never by throwing out of safeParse', () => {
    // Every other field valid, so the object refinements run after the pattern fails.
    for (const priceAmount of ['abc', '1.5']) {
      const parsed = serviceLocationWriteSchema.safeParse({ ...base, priceAmount });
      expect(parsed.success, priceAmount).toBe(false);
    }
  });

  it('takes a limit as a pair, and keeps the initial location panel-wide', () => {
    expect(serviceLocationWriteSchema.safeParse({ ...base, maxChanges: 2 }).success).toBe(false);
    expect(
      serviceLocationWriteSchema.safeParse({
        ...base,
        initial: true,
        productId: '0191f4a0-9e77-7d18-8c03-2b9d4e5a1f60',
      }).success,
    ).toBe(false);
  });
});
