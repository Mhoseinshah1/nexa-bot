import { describe, expect, it } from 'vitest';
import {
  CUSTOM_USERNAME_MAX_LENGTH,
  CUSTOM_USERNAME_MIN_LENGTH,
  LEGACY_USERNAME_PATTERN,
  PROVIDER_USERNAME_FALLBACK_MAX_LENGTH,
  RANDOM_USERNAME_ALPHABET,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  USERNAME_TEMPLATE_TOKEN_NAMES,
  USERNAME_UNIQUENESS_TOKENS,
  isValidCustomUsername,
  normalizeCustomUsername,
  providerUsernameFor,
  renderUsernameTemplate,
  validateUsernameTemplate,
  worstCaseRenderedLength,
} from '@nexa/contracts';

/**
 * The username contract, tested where it is DECIDED rather than where it is used.
 *
 * Every rule here is one a customer or an operator meets directly: what they may type,
 * what an operator may save, and what the two produce. The integration suite proves the
 * reservation and the money; this proves the language those depend on, and it is the
 * only place that can prove a refusal is a refusal rather than a silent repair.
 */

const VALUES = {
  telegram_id: '910910',
  customer_id: '0192ab34cd56789012345678901234ef',
  order_id: '0192ffffcccc0000111122223333aabb',
  random6: 'k3m9qz',
  random10: 'k3m9qz71ab',
} as const;

describe('what a customer may type', () => {
  it('folds only the two differences they cannot see', () => {
    /*
     * Trim and lowercase, and NOTHING else. A normalizer that stripped illegal
     * characters would hand somebody a name they did not choose — and then reserve it,
     * charge for it, and create it on a panel under that name.
     */
    expect(normalizeCustomUsername('  MyService_01  ')).toBe('myservice_01');
    expect(normalizeCustomUsername('ali_2024')).toBe('ali_2024');
    // The illegal characters SURVIVE normalization, so validation can refuse them.
    expect(normalizeCustomUsername(' Ali-2024! ')).toBe('ali-2024!');
  });

  it('accepts the documented baseline at both boundaries', () => {
    expect(isValidCustomUsername('a'.repeat(CUSTOM_USERNAME_MIN_LENGTH))).toBe(true);
    expect(isValidCustomUsername('a'.repeat(CUSTOM_USERNAME_MAX_LENGTH))).toBe(true);
    expect(isValidCustomUsername('ali_2024')).toBe(true);
    expect(isValidCustomUsername('a_______')).toBe(true);
  });

  it('refuses one character either side of the baseline', () => {
    // The boundaries are asserted from the constants, so moving a constant without
    // meaning to moves this test rather than leaving it agreeing with the old value.
    expect(isValidCustomUsername('a'.repeat(CUSTOM_USERNAME_MIN_LENGTH - 1))).toBe(false);
    expect(isValidCustomUsername('a'.repeat(CUSTOM_USERNAME_MAX_LENGTH + 1))).toBe(false);
  });

  it('refuses every character class the baseline excludes', () => {
    expect(isValidCustomUsername('Ali_2024'), 'uppercase').toBe(false);
    expect(isValidCustomUsername('ali-2024'), 'hyphen').toBe(false);
    expect(isValidCustomUsername('ali.2024'), 'dot').toBe(false);
    expect(isValidCustomUsername('ali 2024'), 'space').toBe(false);
    expect(isValidCustomUsername('علی_۱۴۰۳'), 'persian').toBe(false);
    expect(isValidCustomUsername('ali_😀_24'), 'emoji').toBe(false);
  });

  it('refuses a name that does not begin with a letter', () => {
    // Not decoration: `/api/user/{username}` is a route, and a leading digit is an
    // ambiguity with the numeric-id routes this class of panel also serves.
    expect(isValidCustomUsername('2024_ali')).toBe(false);
    expect(isValidCustomUsername('_ali2024')).toBe(false);
  });
});

describe('what an operator may save as a RANDOM template', () => {
  it('accepts a template carrying each uniqueness token', () => {
    for (const token of USERNAME_UNIQUENESS_TOKENS) {
      const verdict = validateUsernameTemplate(`nx_{${token}}`);
      expect(verdict.ok, `{${token}} alone should be sufficient`).toBe(true);
      expect(verdict.issues).toEqual([]);
    }
  });

  it('refuses a template that is empty once trimmed', () => {
    expect(validateUsernameTemplate('   ').issues).toEqual(['EMPTY']);
  });

  it('refuses a token this contract does not define', () => {
    // The closed set is the point: `{first_name}` is exactly the legacy defect —
    // somebody's real name, in Persian, on a third party's panel.
    expect(validateUsernameTemplate('u_{first_name}_{random6}').issues).toContain('UNKNOWN_TOKEN');
    expect(validateUsernameTemplate('u_{date}_{order_id}').issues).toContain('UNKNOWN_TOKEN');
  });

  it('refuses identity tokens with no per-order uniqueness beside them', () => {
    /*
     * The rule that stops a customer's SECOND purchase colliding with their first. A
     * template of who-they-are renders the same string every time.
     */
    const verdict = validateUsernameTemplate('u_{telegram_id}');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toContain('NO_UNIQUENESS_TOKEN');

    expect(validateUsernameTemplate('u_{telegram_id}_{customer_id}').issues).toContain(
      'NO_UNIQUENESS_TOKEN',
    );
    // And the same pair with one uniqueness token added is fine.
    expect(validateUsernameTemplate('u_{telegram_id}_{random6}').ok).toBe(true);
  });

  it('refuses literal text the rendered name could not legally contain', () => {
    expect(validateUsernameTemplate('my-panel_{random6}').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernameTemplate('My_{random6}').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernameTemplate('نکسا_{random6}').issues).toContain('ILLEGAL_CHARACTER');
  });

  it('refuses a stray brace rather than treating it as literal text', () => {
    // `u_{order_id` is far more likely to be a typo than an intention, and a template
    // that silently keeps a brace renders a name every provider refuses.
    expect(validateUsernameTemplate('u_{order_id').issues).toContain('MALFORMED');
    expect(validateUsernameTemplate('u_}{_{random6}').issues).toContain('MALFORMED');
  });

  it('measures the WORST case, not a typical render', () => {
    /*
     * The rule that stops a template passing at save time and failing for the one
     * customer whose Telegram id is longer than the operator's own.
     */
    expect(worstCaseRenderedLength('u_{random6}')).toBe(2 + 6);
    expect(worstCaseRenderedLength('{telegram_id}')).toBe(16);
    expect(worstCaseRenderedLength('{order_id}{random10}')).toBe(32 + 10);
    expect(worstCaseRenderedLength('plain_text')).toBe(10);
  });

  it('refuses a template whose worst case exceeds the provider ceiling', () => {
    const tooLong = `${'u'.repeat(40)}_{order_id}`;
    expect(worstCaseRenderedLength(tooLong)).toBeGreaterThan(PROVIDER_USERNAME_FALLBACK_MAX_LENGTH);
    expect(validateUsernameTemplate(tooLong).issues).toContain('TOO_LONG');

    // And a stricter adapter limit is honoured over the fallback.
    expect(validateUsernameTemplate('u_{order_id}', 64).ok).toBe(true);
    expect(validateUsernameTemplate('u_{order_id}', 16).issues).toContain('TOO_LONG');
  });

  it('reports EVERY issue at once, not the first', () => {
    // An operator fixing one problem per round trip is an operator who gives up.
    const verdict = validateUsernameTemplate('My-{first_name}');
    expect(verdict.ok).toBe(false);
    expect(new Set(verdict.issues)).toEqual(
      new Set(['UNKNOWN_TOKEN', 'ILLEGAL_CHARACTER', 'NO_UNIQUENESS_TOKEN']),
    );
  });

  it('reports the tokens it used, so a surface need not re-parse it', () => {
    const verdict = validateUsernameTemplate('{telegram_id}_{random6}_{telegram_id}');
    expect(verdict.tokens, 'first-appearance order, no duplicates').toEqual([
      'telegram_id',
      'random6',
    ]);
  });
});

describe('what the two produce', () => {
  it('renders every supported placeholder', () => {
    for (const token of USERNAME_TEMPLATE_TOKEN_NAMES) {
      expect(renderUsernameTemplate(`u_{${token}}`, VALUES)).toBe(`u_${VALUES[token]}`);
    }
  });

  it('renders a placeholder used twice, both times', () => {
    expect(renderUsernameTemplate('{random6}_{random6}', VALUES)).toBe(
      `${VALUES.random6}_${VALUES.random6}`,
    );
  });

  it('leaves literal text exactly as written', () => {
    expect(renderUsernameTemplate('nexa_{order_id}_v2', VALUES)).toBe(`nexa_${VALUES.order_id}_v2`);
  });

  it('refuses a render that a bad VALUE made illegal', () => {
    /*
     * `validateUsernameTemplate` bounds the template; this bounds the RESULT, and it is
     * the check a caller's mistake cannot walk past — a uuid that kept its dashes, a
     * Telegram id with a sign. It throws before the name is reserved rather than after
     * the panel refuses it.
     */
    expect(() =>
      renderUsernameTemplate('u_{customer_id}', {
        ...VALUES,
        customer_id: '0192ab34-cd56-7890-1234-5678901234ef',
      }),
    ).toThrow();
    expect(() =>
      renderUsernameTemplate('u_{telegram_id}', { ...VALUES, telegram_id: '-100123' }),
    ).toThrow();
  });
});

describe('the legacy name, which nothing may rename', () => {
  it('recognises what providerUsernameFor produces', () => {
    const derived = providerUsernameFor('0192ab34-cd56-7890-1234-5678901234ef');
    expect(LEGACY_USERNAME_PATTERN.test(derived)).toBe(true);
    expect(derived).toHaveLength(34);
  });

  it('is longer than the CUSTOM contract allows, which is why it needs its own predicate', () => {
    /*
     * The reason this predicate exists. Every existing service carries a 34-character
     * derived name; the CUSTOM baseline tops out at 16. A validation path that used the
     * customer's rule on a stored name would retroactively condemn every service this
     * installation has ever sold.
     */
    const derived = providerUsernameFor('0192ab34-cd56-7890-1234-5678901234ef');
    expect(derived.length).toBeGreaterThan(CUSTOM_USERNAME_MAX_LENGTH);
    expect(isValidCustomUsername(derived)).toBe(false);
    expect(LEGACY_USERNAME_PATTERN.test(derived)).toBe(true);
  });

  it('does not mistake a customer-typed name for a legacy one', () => {
    expect(LEGACY_USERNAME_PATTERN.test('nxdeadbeef')).toBe(false);
    expect(LEGACY_USERNAME_PATTERN.test('ali_2024')).toBe(false);
  });
});

describe('the generation bounds', () => {
  it('retries a collision a bounded number of times', () => {
    // Five, then a refusal BEFORE any debit. A template whose only uniqueness token is
    // {order_id} collides identically for ever, so an unbounded loop would hang a
    // checkout on a configuration mistake instead of reporting one.
    expect(RANDOM_USERNAME_MAX_ATTEMPTS).toBe(5);
  });

  it('mints randomness from an alphabet the rendered pattern already allows', () => {
    expect(RANDOM_USERNAME_ALPHABET).toHaveLength(36);
    expect(/^[a-z0-9]+$/.test(RANDOM_USERNAME_ALPHABET)).toBe(true);
  });
});
