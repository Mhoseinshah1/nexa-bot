import { describe, expect, it } from 'vitest';
import {
  displayedServiceLocation,
  initialLocationOf,
} from '../../apps/api/src/modules/commerce/locations/application/location-change-policy';
import type { ServiceLocationRecord } from '../../apps/api/src/modules/commerce/locations/application/ports';

/**
 * Pre-support A6: the precedence of the location a customer is told, as one pure rule.
 * The end-to-end reads are `tests/integration/presupport-a6-location-label.test.ts`.
 */
const row = (overrides: Partial<ServiceLocationRecord>): ServiceLocationRecord =>
  ({
    id: 'loc',
    tenantId: 't',
    panelId: 'panel',
    productId: null,
    locationKey: 'key',
    label: 'label',
    initial: false,
    enabled: false,
    price: null,
    limits: { cooldownHours: null, maxChanges: null, periodDays: null },
    sortOrder: 0,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  }) as ServiceLocationRecord;

describe('pre-support A6 — displayed service location', () => {
  it('moved label, then the panel initial label, then the product label, then nothing', () => {
    expect(displayedServiceLocation('moved', 'panel', 'product')).toBe('moved');
    expect(displayedServiceLocation(null, 'panel', 'product')).toBe('panel');
    expect(displayedServiceLocation(null, null, 'product')).toBe('product');
    expect(displayedServiceLocation(null, null, null)).toBeNull();
  });

  it("reads only the panel-wide INITIAL row as the panel's location", () => {
    expect(
      initialLocationOf([
        row({ id: 'a' as never, label: 'not initial' }),
        row({ id: 'b' as never, label: 'product scoped', initial: true, productId: 'p' as never }),
        row({ id: 'c' as never, label: 'the initial', initial: true }),
      ])?.label,
    ).toBe('the initial');
    expect(initialLocationOf([row({ label: 'not initial' })])).toBeUndefined();
  });
});
