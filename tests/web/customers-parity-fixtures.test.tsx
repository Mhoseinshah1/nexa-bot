import { describe, expect, it } from 'vitest';
import { DEMO_CUSTOMERS_FAMILY } from './shots/fixtures/demo-parity/customers.ts';
import { DEMO_SUPPORT_FAMILY } from './shots/fixtures/demo-parity/support.ts';

/**
 * The customers-and-support family's DEMO-PARITY fixtures against the frozen contract.
 *
 * `shots-fixtures.test.tsx` parses the default registry only; a demo-parity override that
 * drifted from its schema would make the side-by-side photograph an error card. So every
 * override of this family is parsed here, with the schema its fixture names.
 */
describe('the customers family demo-parity fixtures', () => {
  const all = [...DEMO_CUSTOMERS_FAMILY, ...DEMO_SUPPORT_FAMILY];
  it.each(all.map((fixture) => [`${fixture.method} ${fixture.path}`, fixture] as const))(
    '%s satisfies its response schema',
    (_, fixture) => {
      expect(fixture.schema, 'a 2xx fixture names its schema').not.toBeNull();
      expect(() => fixture.schema?.parse(fixture.body)).not.toThrow();
    },
  );
});
