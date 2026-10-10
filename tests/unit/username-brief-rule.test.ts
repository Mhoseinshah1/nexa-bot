import { describe, expect, it } from 'vitest';
import {
  CUSTOM_USERNAME_MAX_LENGTH,
  CUSTOM_USERNAME_MIN_LENGTH,
  LEGACY_USERNAME_PATTERN,
  PROVIDER_USERNAME_MAX_LENGTH,
  PROVIDER_USERNAME_MIN_LENGTH,
  canonicalizeCustomUsername,
  isNewProviderUsername,
  isValidCustomUsername,
} from '@nexa/contracts';

/**
 * FIX-10 (batch 2026-10-10): the owner's username rule, written down a SECOND time from the
 * brief and held against the contract the server, the bot and the web all read.
 *
 * The brief: four to twenty characters; only lowercase Latin `a-z`, `0-9`, `-`, `_`; at
 * least one letter and at least one digit; no Persian, space, dot, `@` or emoji. Uppercase
 * is INPUT, not identity — the contract folds it (phase 6C), and the stored name is the
 * lowercase one, which is what "only lowercase" means for what is kept.
 *
 * This oracle is deliberately not the contract's own code: a copy of the regex would agree
 * with the regex whatever it said. It walks the characters one by one.
 *
 * Scope, by owner decision: CUSTOM (customer-typed) names only. Generated names keep their
 * per-panel preset, and a stored name — legacy `nx` + 32 hex, an imported one — is never
 * re-judged; the last case below pins that this rule does not reach it.
 */
function briefAllows(raw: string): boolean {
  const chars = [...raw];
  if (chars.length < 4 || chars.length > 20) return false;
  let letter = false;
  let digit = false;
  for (const ch of chars) {
    const code = ch.codePointAt(0) ?? 0;
    const lower = code >= 0x61 && code <= 0x7a;
    const upper = code >= 0x41 && code <= 0x5a;
    const num = code >= 0x30 && code <= 0x39;
    if (lower || upper) letter = true;
    else if (num) digit = true;
    else if (ch !== '-' && ch !== '_') return false;
  }
  return letter && digit;
}

const TABLE: readonly (readonly [string, boolean, string])[] = [
  ['ali1', true, 'four, the floor'],
  ['a1b2c3d4e5f6g7h8i9j0', true, 'twenty, the ceiling'],
  ['ali', false, 'three'],
  ['a1b2c3d4e5f6g7h8i9j0k', false, 'twenty-one'],
  ['ali_2026', true, 'underscore'],
  ['ali-2026', true, 'hyphen'],
  ['Ali_2026', true, 'uppercase is folded, not refused'],
  ['MARYAM99', true, 'all uppercase letters'],
  ['aliserver', false, 'no digit'],
  ['12345678', false, 'no letter'],
  ['____----', false, 'neither'],
  ['علی۱۴۰۳', false, 'Persian letters and digits'],
  ['ali۱۴۰۳', false, 'Persian digits'],
  ['ali_2026_علی', false, 'a Persian tail'],
  ['ali 2026', false, 'inner space'],
  [' ali2026', false, 'leading space'],
  ['ali2026 ', false, 'trailing space'],
  ['ali 2026', false, 'no-break space'],
  ['ali‌2026', false, 'zero-width non-joiner'],
  ['ali.2026', false, 'dot'],
  ['@ali2026', false, 'at'],
  ['ali@2026', false, 'inner at'],
  ['ali😀2026', false, 'emoji'],
  ['ali2026😀', false, 'trailing emoji'],
  ['Аli2026', false, 'Cyrillic А'],
  ['İstanbul12', false, 'dotted capital I'],
  ['ａｌｉ２０２６', false, 'full-width'],
  ['ali/2026', false, 'slash'],
  ['', false, 'empty'],
];

describe('the owner’s username rule (FIX-10), held against the contract', () => {
  it('the contract and the brief give the same verdict on every listed case', () => {
    for (const [raw, expected, why] of TABLE) {
      expect(briefAllows(raw), `oracle: ${why}`).toBe(expected);
      expect(isValidCustomUsername(raw), `contract: ${why}`).toBe(expected);
    }
  });

  it('agrees with the brief on generated strings from the classes the rule names', () => {
    // A small deterministic LCG, so a failure names a reproducible input.
    let seed = 0x5eed;
    const next = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed;
    };
    const alphabet = [...'abcxyzABCXYZ0189_-', ' ', '.', '@', 'ع', '۱', '😀', '‌'];
    for (let i = 0; i < 5000; i += 1) {
      const length = next() % 24;
      let raw = '';
      for (let j = 0; j < length; j += 1) raw += alphabet[next() % alphabet.length];
      expect(isValidCustomUsername(raw), JSON.stringify(raw)).toBe(briefAllows(raw));
    }
  });

  it('keeps only the lowercase form, and that form is a name any provider may be sent', () => {
    for (const [raw, allowed] of TABLE) {
      if (!allowed) continue;
      const kept = canonicalizeCustomUsername(raw);
      expect(kept).toBe(raw.toLowerCase());
      expect(kept).toMatch(/^[a-z0-9_-]{4,20}$/);
      expect(isNewProviderUsername(kept)).toBe(true);
    }
  });

  it('states the same bounds the web panel editor prints', () => {
    // `apps/web/src/pages/panels.tsx` prints PROVIDER_USERNAME_MIN/MAX_LENGTH; the customer
    // bound is the same pair, so the web, the bot's instructions and the server agree.
    expect([CUSTOM_USERNAME_MIN_LENGTH, CUSTOM_USERNAME_MAX_LENGTH]).toEqual([4, 20]);
    expect([PROVIDER_USERNAME_MIN_LENGTH, PROVIDER_USERNAME_MAX_LENGTH]).toEqual([4, 20]);
  });

  it('is not applied to a stored legacy name (no retroactive rule)', () => {
    const legacy = `nx${'a'.repeat(32)}`;
    expect(LEGACY_USERNAME_PATTERN.test(legacy)).toBe(true);
    // The typed-name rule would refuse it — which is exactly why it is never asked of one.
    expect(isValidCustomUsername(legacy)).toBe(false);
  });
});
