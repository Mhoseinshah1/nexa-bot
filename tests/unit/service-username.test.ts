import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CUSTOM_USERNAME_MAX_LENGTH,
  CUSTOM_USERNAME_MIN_LENGTH,
  DEFAULT_USERNAME_PATTERN,
  DEFAULT_USERNAME_PREFIX,
  DEFAULT_USERNAME_STRATEGY,
  LEGACY_USERNAME_PATTERN,
  PREFIX_RANDOM_MIN_RANDOM,
  PROVIDER_USERNAME_MAX_LENGTH,
  PROVIDER_USERNAME_MIN_LENGTH,
  RANDOM_STRATEGY_LENGTH,
  RANDOM_USERNAME_ALPHABET,
  RANDOM_USERNAME_MAX_ATTEMPTS,
  TELEGRAM_ID_RANDOM_SUFFIX_LENGTH,
  USERNAME_PREFIX_MAX_LENGTH,
  USERNAME_REDRAWN_TOKENS,
  USERNAME_STRATEGIES,
  USERNAME_TEMPLATE_TOKEN_NAMES,
  USERNAME_UNIQUENESS_TOKENS,
  assertNewProviderUsername,
  bestCaseRenderedLength,
  canonicalizeCustomUsername,
  drawUsernameCharacters,
  isNewProviderUsername,
  isValidCustomUsername,
  prefixRandomLength,
  previewUsername,
  providerUsernameFor,
  renderUsernameTemplate,
  telegramIdSuffix4,
  usernameDigest4,
  validateUsernamePolicy,
  validateUsernamePrefix,
  validateUsernameTemplate,
  worstCaseRenderedLength,
  type UsernamePolicyDraft,
  type UsernameStrategy,
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
  tg4: '0910',
  customer4: 'ab12',
  order4: 'cd34',
  random4: 'k3m9',
  random6: 'k3m9qz',
  random10: 'k3m9qz71ab',
} as const;

const sha256 = (input: string): string => createHash('sha256').update(input).digest('hex');

const policy = (over: Partial<UsernamePolicyDraft> = {}): UsernamePolicyDraft => ({
  allowCustom: true,
  allowAutomatic: true,
  strategy: DEFAULT_USERNAME_STRATEGY,
  prefix: DEFAULT_USERNAME_PREFIX,
  template: null,
  ...over,
});

describe('the universal contract every new name obeys', () => {
  it('accepts four to twenty characters of the permitted class', () => {
    expect(isNewProviderUsername('a'.repeat(PROVIDER_USERNAME_MIN_LENGTH))).toBe(true);
    expect(isNewProviderUsername('a'.repeat(PROVIDER_USERNAME_MAX_LENGTH))).toBe(true);
    expect(isNewProviderUsername('ali-2026_x')).toBe(true);
  });

  it('refuses one character either side, and every character outside the class', () => {
    expect(isNewProviderUsername('a'.repeat(PROVIDER_USERNAME_MIN_LENGTH - 1))).toBe(false);
    expect(isNewProviderUsername('a'.repeat(PROVIDER_USERNAME_MAX_LENGTH + 1))).toBe(false);
    expect(isNewProviderUsername('Ali_2026'), 'uppercase is not canonical').toBe(false);
    expect(isNewProviderUsername('ali.2026')).toBe(false);
    expect(isNewProviderUsername('ali 2026')).toBe(false);
    expect(isNewProviderUsername('علی_۱۴۰۳')).toBe(false);
  });

  it('asserts rather than refuses, because by then it is OUR mistake', () => {
    /*
     * The adapter boundary. Two checks already passed before a name gets there, so a
     * failure is a defect on our side rather than a customer's or an operator's — and
     * the one thing it must not do is reach somebody's panel.
     */
    expect(() => assertNewProviderUsername('ali_2026')).not.toThrow();
    expect(() => assertNewProviderUsername('a'.repeat(PROVIDER_USERNAME_MAX_LENGTH + 1))).toThrow();
  });
});

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
    expect(CUSTOM_USERNAME_MIN_LENGTH, 'the customer bound IS the universal one').toBe(4);
    expect(CUSTOM_USERNAME_MAX_LENGTH).toBe(20);
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
     * secret. `1234` and `----` are both names a support conversation cannot say out
     * loud, and the second is not obviously a username.
     */
    expect(isValidCustomUsername('12345678'), 'digits only').toBe(false);
    expect(isValidCustomUsername('aliserver'), 'letters only').toBe(false);
    expect(isValidCustomUsername('________'), 'neither').toBe(false);
    expect(isValidCustomUsername('--------'), 'neither').toBe(false);
    expect(isValidCustomUsername('a_-1'), 'one of each is enough').toBe(true);
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

  it('produces a canonical form the universal contract also accepts', () => {
    // The two checks must not be able to disagree: what a customer may type, folded,
    // is what is reserved and what reaches the adapter.
    for (const raw of ['Ali_2026', 'a1b2', 'A'.repeat(19) + '1']) {
      expect(isValidCustomUsername(raw)).toBe(true);
      expect(isNewProviderUsername(canonicalizeCustomUsername(raw))).toBe(true);
    }
  });
});

describe('the default preset', () => {
  it('is nx plus ten characters, and nothing in the contract says 32 or 34', () => {
    expect(DEFAULT_USERNAME_STRATEGY).toBe('PREFIX_RANDOM');
    expect(DEFAULT_USERNAME_PREFIX).toBe('nx');
    expect(prefixRandomLength(DEFAULT_USERNAME_PREFIX)).toBe(10);
    const drawn = `${DEFAULT_USERNAME_PREFIX}${drawUsernameCharacters('00'.repeat(10), 10)}`;
    expect(drawn).toHaveLength(12);
    expect(DEFAULT_USERNAME_PATTERN.test(drawn)).toBe(true);
    expect(isNewProviderUsername(drawn)).toBe(true);
  });

  it('is what an unconfigured panel previews', () => {
    expect(previewUsername(policy())).toMatch(/^nx[a-z0-9]{10}$/);
  });
});

describe('the four presets, and what each one may render', () => {
  it('names exactly four', () => {
    expect([...USERNAME_STRATEGIES]).toEqual([
      'RANDOM',
      'PREFIX_RANDOM',
      'TELEGRAM_ID_RANDOM',
      'CUSTOM_TEMPLATE',
    ]);
  });

  it('RANDOM is exactly twelve characters', () => {
    expect(RANDOM_STRATEGY_LENGTH).toBe(12);
    const preview = previewUsername(policy({ strategy: 'RANDOM', prefix: null }));
    expect(preview).toHaveLength(RANDOM_STRATEGY_LENGTH);
    expect(isNewProviderUsername(preview ?? '')).toBe(true);
  });

  it('PREFIX_RANDOM always leaves at least six random characters and stays inside twenty', () => {
    /*
     * Both halves, across the whole legal prefix range. The floor is what stops a long
     * prefix turning the random component into something two customers collide on; the
     * ceiling is the universal contract.
     */
    for (let length = 1; length <= USERNAME_PREFIX_MAX_LENGTH; length += 1) {
      const prefix = `a${'b'.repeat(length - 1)}`;
      expect(validateUsernamePrefix(prefix).ok, prefix).toBe(true);
      const random = prefixRandomLength(prefix);
      expect(random, `${prefix} leaves ${random}`).toBeGreaterThanOrEqual(PREFIX_RANDOM_MIN_RANDOM);
      expect(prefix.length + random).toBeLessThanOrEqual(PROVIDER_USERNAME_MAX_LENGTH);
      const preview = previewUsername(policy({ strategy: 'PREFIX_RANDOM', prefix }));
      expect(preview).toHaveLength(prefix.length + random);
      expect(isNewProviderUsername(preview ?? ''), preview ?? '').toBe(true);
    }
  });

  it('refuses a prefix that would leave fewer than six, or break the character rule', () => {
    expect(validateUsernamePrefix('a'.repeat(USERNAME_PREFIX_MAX_LENGTH + 1)).issues).toContain(
      'TOO_LONG',
    );
    expect(validateUsernamePrefix('1nx').issues).toContain('NOT_LETTER_FIRST');
    expect(validateUsernamePrefix('-nx').issues).toContain('NOT_LETTER_FIRST');
    expect(validateUsernamePrefix('NX').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernamePrefix('n.x').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernamePrefix('').issues).toEqual(['EMPTY']);
  });

  it('TELEGRAM_ID_RANDOM renders the id IN FULL, never truncated', () => {
    const preview = previewUsername(policy({ strategy: 'TELEGRAM_ID_RANDOM', prefix: null }));
    expect(preview).toBe('5973087728_a3f91c');
    expect(preview).toContain('5973087728');
    expect(preview?.split('_')[1]).toHaveLength(TELEGRAM_ID_RANDOM_SUFFIX_LENGTH);
    expect(isNewProviderUsername(preview ?? '')).toBe(true);
  });

  it('every preset previews inside four to twenty', () => {
    const drafts: readonly UsernamePolicyDraft[] = [
      policy({ strategy: 'RANDOM', prefix: null }),
      policy({ strategy: 'PREFIX_RANDOM', prefix: 'nx' }),
      policy({ strategy: 'PREFIX_RANDOM', prefix: 'a'.repeat(USERNAME_PREFIX_MAX_LENGTH) }),
      policy({ strategy: 'TELEGRAM_ID_RANDOM', prefix: null }),
      policy({ strategy: 'CUSTOM_TEMPLATE', prefix: null, template: 'z{tg4}_{random6}' }),
    ];
    for (const draft of drafts) {
      const preview = previewUsername(draft);
      expect(preview, JSON.stringify(draft)).not.toBeNull();
      expect(isNewProviderUsername(preview ?? ''), preview ?? '').toBe(true);
    }
  });

  it('previews nothing while the policy is not storable, rather than inventing one', () => {
    expect(previewUsername(policy({ allowCustom: false, allowAutomatic: false }))).toBeNull();
    expect(previewUsername(policy({ strategy: 'CUSTOM_TEMPLATE', prefix: null }))).toBeNull();
    expect(previewUsername(policy({ strategy: 'PREFIX_RANDOM', prefix: null }))).toBeNull();
  });
});

describe('what an operator may save as a template', () => {
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
    expect(validateUsernameTemplate('u_{date}_{order4}').issues).toContain('UNKNOWN_TOKEN');
    // The two 32-character tokens this release removed are now unknown like any other.
    expect(validateUsernameTemplate('u_{order_id}').issues).toContain('UNKNOWN_TOKEN');
    expect(validateUsernameTemplate('u_{customer_id}_{random6}').issues).toContain('UNKNOWN_TOKEN');
  });

  it('refuses identity tokens with no per-order uniqueness beside them', () => {
    /*
     * The rule that stops a customer's SECOND purchase colliding with their first. A
     * template of who-they-are renders the same string every time.
     */
    const verdict = validateUsernameTemplate('u_{telegram_id}');
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toContain('NO_UNIQUENESS_TOKEN');

    expect(validateUsernameTemplate('u{tg4}{customer4}').issues).toContain('NO_UNIQUENESS_TOKEN');
    // And the same pair with one uniqueness token added is fine.
    expect(validateUsernameTemplate('u{tg4}{customer4}{random4}').ok).toBe(true);
  });

  it('refuses literal text the rendered name could not legally contain', () => {
    expect(validateUsernameTemplate('My_{random6}').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernameTemplate('نکسا_{random6}').issues).toContain('ILLEGAL_CHARACTER');
    expect(validateUsernameTemplate('a b_{random6}').issues).toContain('ILLEGAL_CHARACTER');
    // A hyphen IS legal now — the universal class carries it.
    expect(validateUsernameTemplate('my-panel_{random6}').ok).toBe(true);
  });

  it('refuses a stray brace rather than treating it as literal text', () => {
    // `u_{order4` is far more likely to be a typo than an intention, and a template
    // that silently keeps a brace renders a name every provider refuses.
    expect(validateUsernameTemplate('u_{order4').issues).toContain('MALFORMED');
    expect(validateUsernameTemplate('u_}{_{random6}').issues).toContain('MALFORMED');
  });

  it('measures BOTH bounds, not a typical render', () => {
    /*
     * The worst case stops a template passing at save time and failing for the one
     * customer whose Telegram id is longer than the operator's own. The best case is
     * the other half: only `{telegram_id}` varies, so a template that reaches twenty
     * for one buyer can fall under four for another.
     */
    expect(worstCaseRenderedLength('u_{random6}')).toBe(2 + 6);
    expect(bestCaseRenderedLength('u_{random6}')).toBe(2 + 6);
    expect(worstCaseRenderedLength('{telegram_id}')).toBe(16);
    expect(bestCaseRenderedLength('{telegram_id}')).toBe(1);
    expect(worstCaseRenderedLength('plain_text')).toBe(10);
  });

  it('refuses a template whose worst case exceeds twenty', () => {
    const tooLong = `${'u'.repeat(12)}_{random10}`;
    expect(worstCaseRenderedLength(tooLong)).toBeGreaterThan(PROVIDER_USERNAME_MAX_LENGTH);
    expect(validateUsernameTemplate(tooLong).issues).toContain('TOO_LONG');
    // `{telegram_id}` is measured at SIXTEEN, not at today's ten digits.
    expect(validateUsernameTemplate('{telegram_id}_{random6}').issues).toContain('TOO_LONG');
    expect(validateUsernameTemplate('{tg4}_{random6}').ok).toBe(true);
  });

  it('refuses a template whose best case falls under four', () => {
    expect(bestCaseRenderedLength('{telegram_id}')).toBeLessThan(PROVIDER_USERNAME_MIN_LENGTH);
    // Two issues at once: too short for one customer AND no uniqueness token at all.
    const verdict = validateUsernameTemplate('{telegram_id}');
    expect(verdict.issues).toContain('TOO_SHORT');
    expect(verdict.issues).toContain('NO_UNIQUENESS_TOKEN');
  });

  it('reports EVERY issue at once, not the first', () => {
    // An operator fixing one problem per round trip is an operator who gives up.
    const verdict = validateUsernameTemplate('My{first_name}');
    expect(verdict.ok).toBe(false);
    expect(new Set(verdict.issues)).toEqual(
      new Set(['UNKNOWN_TOKEN', 'ILLEGAL_CHARACTER', 'NO_UNIQUENESS_TOKEN']),
    );
  });

  it('reports the tokens it used, so a surface need not re-parse it', () => {
    const verdict = validateUsernameTemplate('{tg4}_{random6}_{tg4}');
    expect(verdict.tokens, 'first-appearance order, no duplicates').toEqual(['tg4', 'random6']);
  });

  it('names order4 as unique but NOT as redrawable', () => {
    /*
     * The distinction a collision depends on. `{order4}` makes two customers'
     * purchases different; it does not make ONE order's second attempt different, so
     * redrawing it would mean changing the order's identity to hide a name clash.
     */
    expect([...USERNAME_UNIQUENESS_TOKENS]).toContain('order4');
    expect([...USERNAME_REDRAWN_TOKENS]).not.toContain('order4');
    expect([...USERNAME_REDRAWN_TOKENS]).toEqual(['random4', 'random6', 'random10']);
  });
});

describe('what the presets produce', () => {
  it('renders every supported placeholder', () => {
    for (const token of USERNAME_TEMPLATE_TOKEN_NAMES) {
      expect(renderUsernameTemplate(`u_{${token}}`, VALUES)).toBe(`u_${VALUES[token]}`);
    }
  });

  it('renders a placeholder used twice, both times', () => {
    expect(renderUsernameTemplate('{random6}{random6}', VALUES)).toBe(
      `${VALUES.random6}${VALUES.random6}`,
    );
  });

  it('leaves literal text exactly as written', () => {
    expect(renderUsernameTemplate('nexa-{order4}-v2', VALUES)).toBe(`nexa-${VALUES.order4}-v2`);
  });

  it('takes the LAST four digits of a Telegram id, padded when it is shorter', () => {
    expect(telegramIdSuffix4('5973087728')).toBe('7728');
    expect(telegramIdSuffix4('12')).toBe('0012');
  });

  it('digests an internal id to four stable lowercase characters', () => {
    const first = usernameDigest4('0192ab34-cd56-7890-1234-5678901234ef', sha256);
    const again = usernameDigest4('0192ab34-cd56-7890-1234-5678901234ef', sha256);
    expect(first).toHaveLength(4);
    expect(first).toMatch(/^[a-z0-9]{4}$/);
    expect(again, 'stable across calls, which is what a replay depends on').toBe(first);
    expect(usernameDigest4('a-different-id', sha256)).not.toBe(first);
  });

  it('refuses a hasher that is not SHA-256 hex, rather than digesting rubbish', () => {
    expect(() => usernameDigest4('x', () => 'not-a-digest')).toThrow();
  });

  it('refuses a render that a bad VALUE made illegal', () => {
    /*
     * `validateUsernameTemplate` bounds the template; this bounds the RESULT, and it is
     * the check a caller's mistake cannot walk past — a digest that kept its dashes, a
     * Telegram id with a sign. It throws before the name is reserved rather than after
     * the panel refuses it.
     */
    expect(() =>
      renderUsernameTemplate('u_{customer4}', { ...VALUES, customer4: 'AB-12' }),
    ).toThrow();
    /*
     * A hyphen IS legal now, so the value that proves this check has to carry a
     * character the class refuses — `+` is what a mis-parsed chat id looks like.
     */
    expect(() =>
      renderUsernameTemplate('u_{telegram_id}', { ...VALUES, telegram_id: '+100123' }),
    ).toThrow();
  });

  it('draws only from the alphabet the contract permits', () => {
    const drawn = drawUsernameCharacters('00112233445566778899aabbccddeeff', 16);
    expect(drawn).toHaveLength(16);
    expect(/^[a-z0-9]+$/.test(drawn)).toBe(true);
    expect(drawUsernameCharacters('00'.repeat(10), 10)).toBe('aaaaaaaaaa');
  });

  it('refuses to draw from too little entropy rather than repeating itself', () => {
    expect(() => drawUsernameCharacters('00', 10)).toThrow();
  });
});

describe('the whole policy, decided once', () => {
  it('refuses both choices disabled, with words a surface can render', () => {
    const verdict = validateUsernamePolicy(policy({ allowCustom: false, allowAutomatic: false }));
    expect(verdict.ok).toBe(false);
    expect(verdict.refusal).toBe('NO_MODE');
    expect(verdict.reason).not.toBeNull();
  });

  it('accepts either one alone', () => {
    expect(validateUsernamePolicy(policy({ allowAutomatic: false })).ok).toBe(true);
    expect(validateUsernamePolicy(policy({ allowCustom: false })).ok).toBe(true);
  });

  it('refuses a preset with no configuration behind it', () => {
    expect(
      validateUsernamePolicy(policy({ strategy: 'PREFIX_RANDOM', prefix: null })).refusal,
    ).toBe('STRATEGY_CONFIGURATION');
    expect(
      validateUsernamePolicy(policy({ strategy: 'CUSTOM_TEMPLATE', prefix: null })).refusal,
    ).toBe('STRATEGY_CONFIGURATION');
  });

  it('carries the failing half s own verdict, so a surface can list the issues', () => {
    const bad = validateUsernamePolicy(
      policy({ strategy: 'CUSTOM_TEMPLATE', prefix: null, template: 'My{first_name}' }),
    );
    expect(bad.refusal).toBe('TEMPLATE');
    expect(bad.template?.issues.length).toBeGreaterThan(1);

    const worse = validateUsernamePolicy(policy({ strategy: 'PREFIX_RANDOM', prefix: '1x' }));
    expect(worse.refusal).toBe('PREFIX');
    expect(worse.prefix?.issues).toContain('NOT_LETTER_FIRST');
  });

  it('ignores the OTHER preset s configuration, so a strategy change is not trapped', () => {
    /*
     * A template left behind by a move to PREFIX_RANDOM is inert, and refusing an
     * unrelated edit because of it would trap an operator on a panel they can no
     * longer configure. What is refused is a preset with NOTHING behind it, above.
     */
    const moved: UsernamePolicyDraft = policy({
      strategy: 'PREFIX_RANDOM',
      prefix: 'nx',
      template: 'My{first_name}',
    });
    expect(validateUsernamePolicy(moved).ok).toBe(true);
  });

  it('judges every preset the same way whichever surface asks', () => {
    // One evaluator, so a policy the Web Admin previewed cannot be refused by Telegram
    // for a reason it did not know about. The assertion is that the function is total.
    for (const strategy of USERNAME_STRATEGIES) {
      const draft = policy({
        strategy: strategy as UsernameStrategy,
        prefix: strategy === 'PREFIX_RANDOM' ? 'nx' : null,
        template: strategy === 'CUSTOM_TEMPLATE' ? 'z{tg4}_{random6}' : null,
      });
      expect(validateUsernamePolicy(draft).ok, strategy).toBe(true);
      expect(previewUsername(draft), strategy).not.toBeNull();
    }
  });
});

describe('the legacy name, which nothing may rename', () => {
  it('recognises the shape that was minted before this contract', () => {
    const derived = providerUsernameFor('0192ab34-cd56-7890-1234-5678901234ef');
    expect(LEGACY_USERNAME_PATTERN.test(derived)).toBe(true);
    expect(derived).toHaveLength(34);
  });

  it('is longer than every NEW name, which is why it needs its own predicate', () => {
    /*
     * The reason this predicate exists, and the reason nothing renames a service.
     * Existing services carry a 34-character derived name; a new one tops out at 20.
     * A validation path that used the new rule on a STORED name would retroactively
     * condemn every service this installation has ever sold.
     */
    const derived = providerUsernameFor('0192ab34-cd56-7890-1234-5678901234ef');
    expect(derived.length).toBeGreaterThan(PROVIDER_USERNAME_MAX_LENGTH);
    expect(isNewProviderUsername(derived), 'too long to be MINTED today').toBe(false);
    expect(LEGACY_USERNAME_PATTERN.test(derived), 'and still recognisable as legacy').toBe(true);
  });

  it('does not mistake a customer-typed name for a legacy one', () => {
    expect(LEGACY_USERNAME_PATTERN.test('nxdeadbeef')).toBe(false);
    expect(LEGACY_USERNAME_PATTERN.test('ali_2024')).toBe(false);
    // Nor the new default, which shares the `nx` prefix and nothing else.
    expect(LEGACY_USERNAME_PATTERN.test('nx4fa2bc91de')).toBe(false);
    expect(DEFAULT_USERNAME_PATTERN.test('nx4fa2bc91de')).toBe(true);
  });
});

describe('the generation bounds', () => {
  it('retries a collision a bounded number of times', () => {
    // Five, then a refusal BEFORE any debit. A template whose only uniqueness token is
    // {order4} collides identically for ever, so an unbounded loop would hang a
    // checkout on a configuration mistake instead of reporting one.
    expect(RANDOM_USERNAME_MAX_ATTEMPTS).toBe(5);
  });

  it('mints randomness from an alphabet the rendered pattern already allows', () => {
    expect(RANDOM_USERNAME_ALPHABET).toHaveLength(36);
    expect(/^[a-z0-9]+$/.test(RANDOM_USERNAME_ALPHABET)).toBe(true);
  });
});
