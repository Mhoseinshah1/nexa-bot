import { describe, expect, it } from 'vitest';
import { productWriteSchema } from '@nexa/contracts';
import { bodyFrom } from '../../apps/web/src/pages/products';

/**
 * WP21: the Web Admin form and the server hold a typed traffic figure to ONE rule. The form
 * validates with the contract's `parseTrafficGb`, the schema with the same pattern, so a
 * figure the form sends is a figure the server takes, and the other way round.
 */
const state = (trafficGb: string, trafficUnlimited = false) => ({
  title: 'پلن',
  description: '',
  audience: 'EVERYONE' as const,
  sortOrder: '0',
  panelId: '',
  durationDays: '30',
  trafficGb,
  trafficUnlimited,
  deviceLimit: '',
  priceAmount: '',
  priceCurrency: 'IRT' as const,
  categoryId: '',
  displayLocations: [],
  displayFeatures: [],
  serviceLocationLabel: '',
});

const wire = (trafficGb: string | null) => ({
  idempotencyKey: 'wp21-product-key',
  title: 'پلن',
  description: null,
  audience: 'EVERYONE',
  sortOrder: 0,
  panelId: null,
  durationDays: 30,
  trafficGb,
  deviceLimit: null,
  priceAmount: null,
  priceCurrency: null,
  categoryId: null,
});

describe('the Web Admin form and the server share one traffic rule', () => {
  it('accepts exactly what the schema accepts', () => {
    for (const text of [
      '1',
      '1.5',
      '1.50',
      '10.25',
      '0.01',
      '1024000',
      '0',
      '0.00',
      '1.234',
      '-1',
      '1e3',
      '1,5',
      '.5',
      '1024000.01',
    ]) {
      const form = bodyFrom(state(text));
      expect('body' in form, text).toBe(productWriteSchema.safeParse(wire(text)).success);
    }
  });

  it('sends null, not zero, for unlimited, and the schema takes it', () => {
    const form = bodyFrom(state('', true));
    expect('body' in form && form.body.trafficGb).toBeNull();
    expect(productWriteSchema.safeParse(wire(null)).success).toBe(true);
  });
});
