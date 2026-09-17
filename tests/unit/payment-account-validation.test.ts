import { describe, expect, it } from 'vitest';
import {
  isValidCardNumber,
  isValidIban,
  normalizeCardNumber,
  normalizeIban,
  paymentAccountInputSchema,
} from '@nexa/contracts';

/*
 * A real Iranian card number and a real Sheba SHAPE, both fabricated.
 *
 * `6037991234567893` is a Bank Melli BIN with a check digit computed to satisfy Luhn, and
 * the Sheba's two check digits are computed to satisfy mod-97. Neither addresses an
 * account that exists anywhere, which is the point: these tests are about STRUCTURE, and
 * a real card number in a repository would be a real card number in a repository.
 */
const CARD = '6037991234567893';
const SHEBA = 'IR429600000001003242000012';

describe('card number normalisation', () => {
  it('accepts the digits a Persian keyboard produces', () => {
    // An operator pastes out of a banking app or a bank SMS and gets Persian digits.
    // Without the conversion they are told their own card number is malformed.
    expect(
      normalizeCardNumber(
        '\u06F6\u06F0\u06F3\u06F7\u06F9\u06F9\u06F1\u06F2\u06F3\u06F4\u06F5\u06F6\u06F7\u06F8\u06F9\u06F3',
      ),
    ).toBe(CARD);
  });

  it('accepts Arabic-Indic digits too', () => {
    expect(
      normalizeCardNumber(
        '\u0666\u0660\u0663\u0667\u0669\u0669\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668\u0669\u0663',
      ),
    ).toBe(CARD);
  });

  it('removes the separators a human types, including invisible ones', () => {
    // The bidi marks are the ones that matter: an RTL copy carries them, nothing renders
    // them, and a deny-list that forgets them refuses a number that looks correct.
    expect(normalizeCardNumber('6037-9912-3456-7893')).toBe(CARD);
    expect(normalizeCardNumber('6037 9912 3456 7893')).toBe(CARD);
    expect(normalizeCardNumber('\u200E6037\u200C9912\u00A03456\u200F7893')).toBe(CARD);
  });

  it('refuses anything that is not exactly sixteen digits', () => {
    expect(normalizeCardNumber('603799123456789')).toBeNull();
    expect(normalizeCardNumber('60379912345678931')).toBeNull();
    expect(normalizeCardNumber('')).toBeNull();
  });

  it('refuses a transposed pair through the check digit', () => {
    // The commonest data-entry error, and the one a length check cannot see.
    const transposed = '6037991234567839';
    expect(normalizeCardNumber(transposed)).toBe(transposed);
    expect(isValidCardNumber(transposed)).toBe(false);
    expect(isValidCardNumber(CARD)).toBe(true);
  });

  it('refuses an unnormalised string rather than normalising inside the check', () => {
    // One normalisation, at the boundary. A validator that also normalised would be a
    // second opinion about what a card number is.
    expect(isValidCardNumber('6037 9912 3456 7893')).toBe(false);
  });
});

describe('Sheba normalisation', () => {
  it('accepts the prefix in either case, or not at all', () => {
    expect(normalizeIban('ir42 9600 0000 0100 3242 0000 12')).toBe(SHEBA);
    expect(normalizeIban(SHEBA)).toBe(SHEBA);
    expect(normalizeIban('429600000001003242000012')).toBe(SHEBA);
  });

  it('refuses a wrong length and a wrong country', () => {
    expect(normalizeIban('IR42960000000100324200001')).toBeNull();
    expect(normalizeIban('DE429600000001003242000012')).toBeNull();
  });

  it('refuses a wrong check digit through mod-97', () => {
    const wrong = 'IR439600000001003242000012';
    expect(normalizeIban(wrong)).toBe(wrong);
    expect(isValidIban(wrong)).toBe(false);
    expect(isValidIban(SHEBA)).toBe(true);
  });

  it('computes mod-97 over the whole twenty-six characters', () => {
    /*
     * The falsification this test exists for. A `Number`-based implementation of mod-97
     * overflows past 2^53 and returns a plausible answer, so a Sheba differing only in a
     * late digit would pass. Changing the last digit must be caught.
     */
    expect(isValidIban('IR429600000001003242000013')).toBe(false);
  });
});

describe('paymentAccountInputSchema', () => {
  const valid = {
    label: 'ملی',
    bankName: 'بانک ملی ایران',
    holderName: 'محمد حسین شاه',
    cardNumber: '6037-9912-3456-7893',
    iban: SHEBA,
    sortOrder: 0,
  };

  it('normalises on the way in, so what the service gets is what is stored', () => {
    const parsed = paymentAccountInputSchema.parse(valid);
    expect(parsed.cardNumber).toBe(CARD);
    expect(parsed.iban).toBe(SHEBA);
  });

  it('treats an absent, null or empty Sheba as no Sheba', () => {
    // A web form submits '' for a field the operator cleared. Refusing it would make
    // removing a Sheba impossible through the only surface that can.
    expect(paymentAccountInputSchema.parse({ ...valid, iban: '' }).iban).toBeNull();
    expect(paymentAccountInputSchema.parse({ ...valid, iban: null }).iban).toBeNull();
    const { iban: _omitted, ...withoutIban } = valid;
    expect(paymentAccountInputSchema.parse(withoutIban).iban).toBeNull();
  });

  it('refuses a malformed card number and a malformed Sheba', () => {
    expect(() => paymentAccountInputSchema.parse({ ...valid, cardNumber: '1234' })).toThrow();
    expect(() =>
      paymentAccountInputSchema.parse({ ...valid, cardNumber: '6037991234567839' }),
    ).toThrow();
    expect(() => paymentAccountInputSchema.parse({ ...valid, iban: 'IR00' })).toThrow();
  });

  it('refuses an empty bank name or holder name', () => {
    // Both are rendered to a customer. A blank line in a transfer instruction is an
    // instruction with a hole in it.
    expect(() => paymentAccountInputSchema.parse({ ...valid, bankName: '   ' })).toThrow();
    expect(() => paymentAccountInputSchema.parse({ ...valid, holderName: '' })).toThrow();
  });
});
