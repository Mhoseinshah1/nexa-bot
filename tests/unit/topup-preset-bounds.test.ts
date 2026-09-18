import { describe, expect, it } from 'vitest';
import { PAYMENT_AMOUNT_MAX_MINOR, settingDefinition } from '@nexa/contracts';

/**
 * `wallet.topup.presets` is bounded above by the payment ceiling.
 *
 * A preset is rendered as a real Telegram button and copied verbatim into
 * `payments.amount`, a `bigint` column. The setting used to validate only that a preset
 * is positive, so an operator could save one larger than the column holds and the
 * customer met it as a button that 500s — or one inside the column but above
 * `PAYMENT_AMOUNT_MAX_MINOR`, which the product's own rail refuses at the tap. Both are
 * refused where the operator is looking at the field.
 */
describe('wallet.topup.presets bounds', () => {
  const schema = settingDefinition('wallet.topup.presets').schema;
  const preset = (amountMinor: bigint) => ({
    amountMinor: amountMinor.toString(),
    currency: 'IRT',
  });

  it('admits a preset at the payment ceiling', () => {
    expect(schema.safeParse([preset(PAYMENT_AMOUNT_MAX_MINOR)]).success).toBe(true);
  });

  it('refuses a preset one above the payment ceiling', () => {
    expect(schema.safeParse([preset(PAYMENT_AMOUNT_MAX_MINOR + 1n)]).success).toBe(false);
  });

  it('refuses a preset the bigint column could not hold at all', () => {
    expect(schema.safeParse([preset(9_223_372_036_854_775_808n)]).success).toBe(false);
  });

  it('still refuses zero and negatives, which the ceiling did not replace', () => {
    expect(schema.safeParse([preset(0n)]).success).toBe(false);
    expect(schema.safeParse([preset(-1n)]).success).toBe(false);
  });
});
