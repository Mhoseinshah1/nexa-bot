import { describe, expect, it } from 'vitest';
import { NAV, navPermitted } from '../../apps/web/src/app';
import { minorOf } from '../../apps/web/src/pages/payment-gateways';

/**
 * Two rules the Codex review of the payment batch found broken on this screen.
 *
 * `minorOf` used to delete every non-digit and submit the remainder as though the
 * operator had typed it: `-100` became a positive `100`, `1e6` became `16`, and the server
 * saw a valid number with nothing to report. These two fields decide which customer
 * payments a route accepts. Now it accepts only ways of WRITING a whole number of minor
 * units, and refuses everything else so the caller can say so against the field.
 */
describe('minorOf', () => {
  it('keeps a plain integer and strips leading zeros', () => {
    expect(minorOf('500000')).toBe('500000');
    expect(minorOf('0042')).toBe('42');
    expect(minorOf('  7  ')).toBe('7');
  });

  it('reads empty as "no bound"', () => {
    expect(minorOf('')).toBe('0');
    expect(minorOf('   ')).toBe('0');
  });

  it('accepts grouping separators and Persian or Arabic-Indic digits', () => {
    expect(minorOf('1,000,000')).toBe('1000000');
    expect(minorOf('1 000 000')).toBe('1000000');
    expect(minorOf('۱٬۰۰۰٬۰۰۰')).toBe('1000000');
    expect(minorOf('١٢٣')).toBe('123');
  });

  it('refuses a sign, a decimal point, an exponent or letters rather than rewriting them', () => {
    // The two Codex named: a sign inverted to a positive bound, an exponent read as digits.
    expect(minorOf('-100')).toBeNull();
    expect(minorOf('1e6')).toBeNull();
    expect(minorOf('+100')).toBeNull();
    expect(minorOf('10.5')).toBeNull();
    expect(minorOf('abc')).toBeNull();
    expect(minorOf('12a')).toBeNull();
  });
});

/**
 * The two payment navigation entries require the VIEW key, and only that.
 *
 * They used to admit either key on the stated ground that an edit-only role could use
 * the page. It could not: the route disables the list on `!view`, the form opens from a
 * row, and the server's `list` charges `view`. A link is a promise that a page will work.
 */
describe('payment navigation permissions', () => {
  const entry = (id: string) => {
    const found = NAV.find((candidate) => candidate.id === id);
    if (found === undefined) throw new Error(`no nav entry ${id}`);
    return found;
  };

  it.each([
    ['payment-accounts', 'payments.accounts.view', 'payments.accounts.edit'],
    ['payment-gateways', 'payments.gateways.view', 'payments.gateways.edit'],
  ])('%s is shown for view and hidden for edit alone', (id, view, edit) => {
    expect(navPermitted(entry(id), [view])).toBe(true);
    expect(navPermitted(entry(id), [view, edit])).toBe(true);
    expect(navPermitted(entry(id), [edit])).toBe(false);
    expect(navPermitted(entry(id), [])).toBe(false);
  });
});
