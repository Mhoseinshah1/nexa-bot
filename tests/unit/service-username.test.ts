import { describe, expect, it } from 'vitest';
import {
  CUSTOM_USERNAME_MAX_LENGTH,
  CUSTOM_USERNAME_MIN_LENGTH,
  LEGACY_USERNAME_PATTERN,
  PROVEN_PROVIDER_USERNAME_MAX_LENGTH,
  RANDOM_USERNAME_ALPHABET,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  USERNAME_TEMPLATE_TOKEN_NAMES,
  USERNAME_UNIQUENESS_TOKENS,
  canonicalizeCustomUsername,
  isValidCustomUsername,
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
  it('accepts either case, and folds only the case', () => {
    /*
     * Case is INPUT, not identity. A customer types what their keyboard gives them and
     * the identity is the lowercase form; the fold is the ONLY rewrite this contract
     * permits, and it happens once, at the boundary, before anything durable sees it.
     */
    expect(isValidCustomUsername('Ali_2026')).toBe(true);
    expect(isValidCustomUsername('ali_2026')).toBe(true);
    expect(isValidCustomUsername('ALI_2026')).toBe(true);
    expect(canonicalizeCustomUsername('Ali_2026')).toBe('ali_2026');
    expect(canonicalizeCustomUsername('ALI_2026')).toBe('ali_2026');
    expect(canonicalizeCustomUsername('ali_2026')).toBe('ali_2026');
  });

  it('resolves differently-cased spellings to ONE identity', () => {
    /*
     * The rule the reservation and the unique index both rest on. If these ever stopped
     * agreeing, `Ali_2026` and `ali_2026` would be two accounts for one name — which an
     * operator reading a client list cannot tell apart, and which makes the usage
     * figures of both meaningless.
     */
    const spellings = ['Ali_2026', 'ali_2026', 'ALI_2026', 'aLi_2026'];
    const identities = new Set(spellings.map(canonicalizeCustomUsername));
    expect(spellings.every(isValidCustomUsername)).toBe(true);
    expect(identities).toEqual(new Set(['ali_2026']));
  });

  it('accepts every character class the baseline allows', () => {
    expect(isValidCustomUsername('ali_2026'), 'underscore').toBe(true);
    expect(isValidCustomUsername('ali-2026'), 'hyphen').toBe(true);
    expect(isValidCustomUsername('Ali-Reza_26'), 'both, mixed case').toBe(true);
    expect(isValidCustomUsername('a1b2c3d4'), 'letters and digits only').toBe(true);
  });

  it('accepts the documented length at both boundaries', () => {
    // Built from the constants, so moving one moves this test rather than leaving it
    // agreeing with the old value. Each carries a digit, as the rule below requires.
    const atMin = `${'a'.repeat(CUSTOM_USERNAME_MIN_LENGTH - 1)}1`;
    const atMax = `${'a'.repeat(CUSTOM_USERNAME_MAX_LENGTH - 1)}1`;
    expect(atMin).toHaveLength(CUSTOM_USERNAME_MIN_LENGTH);
    expect(atMax).toHaveLength(CUSTOM_USERNAME_MAX_LENGTH);
    expect(isValidCustomUsername(atMin)).toBe(true);
    expect(isValidCustomUsername(atMax)).toBe(true);
  });

  it('refuses one character either side of the length', () => {
    expect(isValidCustomUsername(`${'a'.repeat(CUSTOM_USERNAME_MIN_LENGTH - 2)}1`)).toBe(false);
    expect(isValidCustomUsername(`${'a'.repeat(CUSTOM_USERNAME_MAX_LENGTH)}1`)).toBe(false);
  });

  it('requires at least one English letter and at least one digit', () => {
    /*
     * A legibility rule, not a strength rule — a username is an identifier, not a
     * secret. `12345678` and `--------` are both eight characters a support
     * conversation cannot say out loud, and the second is not obviously a username.
     */
    expect(isValidCustomUsername('12345678'), 'digits only').toBe(false);
    expect(isValidCustomUsername('aliserver'), 'letters only').toBe(false);
    expect(isValidCustomUsername('________'), 'neither').toBe(false);
    expect(isValidCustomUsername('--------'), 'neither').toBe(false);
    expect(isValidCustomUsername('_-_-1a_-'), 'one of each is enough').toBe(true);
  });

  it('refuses non-ASCII letters and digits rather than folding them', () => {
    /*
     * `۱۴۰۳` LOOKS like digits and is not `1403`; `Аli` with a Cyrillic А renders
     * identically to `Ali` and is a different string. Neither is repaired, because a
     * name this installation altered is a name the customer would not recognise on
     * their own service.
     */
    expect(isValidCustomUsername('علی_۱۴۰۳'), 'persian letters and digits').toBe(false);
    expect(isValidCustomUsername('ali_۱۴۰۳'), 'persian digits alone').toBe(false);
    expect(isValidCustomUsername('Аli_2026'), 'cyrillic А').toBe(false);
    expect(isValidCustomUsername('ali_😀_26'), 'emoji').toBe(false);
  });

  it('refuses the punctuation a name is most often mistyped with', () => {
    expect(isValidCustomUsername('ali.2026'), 'dot').toBe(false);
    expect(isValidCustomUsername('@ali_2026'), 'at').toBe(false);
    expect(isValidCustomUsername('ali/2026'), 'slash').toBe(false);
    expect(isValidCustomUsername('ali+2026'), 'plus').toBe(false);
    expect(isValidCustomUsername('ali:2026'), 'colon').toBe(false);
  });

  it('REFUSES whitespace rather than trimming it away', () => {
    /*
     * The one place this contract deliberately does less than it could. A trailing
     * space is a difference the customer cannot see, and silently removing it is still
     * a rewrite — the same class of act as stripping an emoji. They are told, and they
     * type it again.
     */
    expect(isValidCustomUsername(' ali_2026')).toBe(false);
    expect(isValidCustomUsername('ali_2026 ')).toBe(false);
    expect(isValidCustomUsername('ali 2026')).toBe(false);
    expect(isValidCustomUsername('\tali_2026')).toBe(false);
  });

  it('canonicalizes with the ASCII fold, not the Unicode one', () => {
    /*
     * Validate FIRST, then fold, and the order is not interchangeable. `toLowerCase` is
     * Unicode-aware — 'İ' folds to two code points — so folding before the ASCII-only
     * check would let a refused character arrive already disguised as an allowed one.
     * By the time the fold runs, only `A-Z` remains.
     */
    expect(isValidCustomUsername('İstanbul12')).toBe(false);
    expect(canonicalizeCustomUsername('ALI-2026_X')).toBe('ali-2026_x');
    // Digits, hyphens and underscores are untouched by the fold.
    expect(canonicalizeCustomUsername('a1-b2_C3d4')).toBe('a1-b2_c3d4');
  });
});

describe('what an operator may save as a RANDOM template', () => {
  it('accepts a template carrying each uniqueness token', () => {
    for (const token of USERNAME_UNIQUENESS_TOKENS) {
      /*
       * A generous ceiling is passed deliberately: this asserts the UNIQUENESS rule,
       * and `{order_id}` is 32 of the proven 34 characters on its own, so a prefix of
       * any length would make this test fail for the wrong reason. Length has its own
       * test, against the real default, below.
       */
      const verdict = validateUsernameTemplate(`nx_{${token}}`, 64);
      expect(verdict.ok, `{${token}} alone should be sufficient`).toBe(true);
      expect(verdict.issues).toEqual([]);
    }
  });

  it('leaves almost nothing beside {order_id}, and says so at save time', () => {
    /*
     * Not a defect — a consequence worth pinning. `{order_id}` is 32 characters of the
     * 34 this product has evidence a panel accepts, so it admits a two-character
     * prefix and no more. An operator who wants a readable prefix uses `{random10}`.
     *
     * The value of asserting it here is that the refusal happens while they are
     * looking at the field. The alternative shape of this rule — a generous ceiling
     * that defers the question — moves the same refusal to a customer's purchase.
     */
    expect(validateUsernameTemplate('nx{order_id}').ok).toBe(true);
    expect(validateUsernameTemplate('nx_{order_id}').issues).toContain('TOO_LONG');
    expect(validateUsernameTemplate('customer_{random10}').ok).toBe(true);
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

  it('refuses a template whose worst case exceeds the proven provider ceiling', () => {
    const tooLong = `${'u'.repeat(40)}_{order_id}`;
    expect(worstCaseRenderedLength(tooLong)).toBeGreaterThan(PROVEN_PROVIDER_USERNAME_MAX_LENGTH);
    expect(validateUsernameTemplate(tooLong).issues).toContain('TOO_LONG');

    /*
     * The bound is a PARAMETER, and the proven 34 is only its default. `u_{order_id}`
     * is exactly 34, so it passes at the default and at anything looser, and fails the
     * moment an adapter declares something tighter — which is the whole reason the
     * caller may pass one rather than this reading a constant.
     */
    expect(worstCaseRenderedLength('u_{order_id}')).toBe(PROVEN_PROVIDER_USERNAME_MAX_LENGTH);
    expect(validateUsernameTemplate('u_{order_id}').ok).toBe(true);
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
    expect(isValidCustomUsername(derived), 'too long, and carries no digit-free rule').toBe(false);
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
