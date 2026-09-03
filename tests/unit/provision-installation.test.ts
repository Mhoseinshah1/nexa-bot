import { describe, expect, it } from 'vitest';
import { validateProvisionInput } from '../../apps/api/src/provision-installation.cli';

/**
 * Provisioning input is operator input, and it reaches a unique index and four
 * CHECK constraints.
 *
 * Validated here rather than left to Postgres, because a constraint violation
 * names a constraint and an installer needs to name the mistake. Every case
 * below is a value an operator could plausibly type.
 */
describe('provision-installation input', () => {
  const valid = {
    slug: 'acme',
    displayName: 'Acme Store',
    locale: 'fa',
    timezone: 'Asia/Tehran',
    calendar: 'jalali',
    currency: 'IRT',
  };

  it('accepts a well-formed installation', () => {
    expect(() => validateProvisionInput(valid)).not.toThrow();
  });

  it.each([
    ['an empty slug', ''],
    ['an uppercase slug', 'Acme'],
    ['a slug with a space', 'acme store'],
    ['a slug starting with a hyphen', '-acme'],
    ['a slug ending with a hyphen', 'acme-'],
    ['a slug with a slash', 'acme/store'],
    // A path segment that traverses is refused for the same reason as the rest:
    // the slug is an identity an operator types and a later surface may route on.
    ['a traversing slug', '../etc'],
  ])('refuses %s', (_name, slug) => {
    expect(() => validateProvisionInput({ ...valid, slug })).toThrowError(/slug/);
  });

  it('accepts a slug at the length limit and refuses one past it', () => {
    const at = 'a'.repeat(63);
    expect(() => validateProvisionInput({ ...valid, slug: at })).not.toThrow();
    expect(() => validateProvisionInput({ ...valid, slug: `${at}a` })).toThrowError(/slug/);
  });

  it('refuses an empty display name', () => {
    expect(() => validateProvisionInput({ ...valid, displayName: '   ' })).toThrowError(
      /display name/,
    );
  });

  it('refuses a calendar and a currency the schema does not declare', () => {
    expect(() => validateProvisionInput({ ...valid, calendar: 'hijri' })).toThrowError(/calendar/);
    expect(() => validateProvisionInput({ ...valid, currency: 'GBP' })).toThrowError(/currency/);
  });

  it('refuses a time zone the platform cannot resolve', () => {
    // Silently accepting this renders every date in the admin UI wrongly, for
    // every administrator, with nothing to point at.
    expect(() => validateProvisionInput({ ...valid, timezone: 'Mars/Olympus' })).toThrowError(
      /IANA time zone/,
    );
  });

  it('reports every problem at once', () => {
    // An installer that fixes one field per run is an installer somebody runs
    // six times. The configuration loader already reports every invalid key in
    // one pass; this matches it.
    let message = '';
    try {
      validateProvisionInput({ ...valid, slug: 'BAD', calendar: 'hijri', currency: 'GBP' });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/slug/);
    expect(message).toMatch(/calendar/);
    expect(message).toMatch(/currency/);
  });
});
