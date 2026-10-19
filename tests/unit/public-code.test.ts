import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isPublicCode,
  orderCodeOf,
  productCode,
  productCodeNumberFromSearch,
  publicCodeFromSearch,
  PUBLIC_CODE_ALPHABET,
  PUBLIC_CODE_LENGTH,
  PUBLIC_CODE_PATTERN,
} from '@nexa/contracts';

/**
 * Round 4, PR-C: the short public code's format, and the three places it is spelled — the
 * contract, the database's generator (0259) and the database's CHECK (0258) — agreeing.
 */
const DRIZZLE = join(__dirname, '..', '..', 'apps', 'api', 'drizzle');

describe('the public code format', () => {
  it("is Crockford base32 without 0/O/1/I/L (and Crockford's own U): 30 symbols", () => {
    expect(PUBLIC_CODE_ALPHABET).toHaveLength(30);
    expect(new Set(PUBLIC_CODE_ALPHABET).size).toBe(30);
    for (const excluded of ['0', 'O', '1', 'I', 'L', 'U']) {
      expect(PUBLIC_CODE_ALPHABET).not.toContain(excluded);
    }
    expect(PUBLIC_CODE_ALPHABET).toMatch(/^[0-9A-Z]+$/u);
    expect(PUBLIC_CODE_LENGTH).toBe(8);
  });

  it('the pattern accepts exactly 8 symbols of the alphabet', () => {
    for (const symbol of PUBLIC_CODE_ALPHABET) {
      expect(isPublicCode(symbol.repeat(8)), symbol).toBe(true);
    }
    for (const bad of [
      'K7M2P9Q',
      'K7M2P9QAA',
      'K7M2P9Q0',
      'K7M2P9QO',
      'K7M2P9Q1',
      'K7M2P9QI',
      'K7M2P9QL',
      'k7m2p9qa',
      'K7M2-9QA',
    ]) {
      expect(isPublicCode(bad), bad).toBe(false);
    }
  });

  it('the database generates from the same alphabet and checks the same pattern', () => {
    const triggers = readFileSync(join(DRIZZLE, '0259_public_code_triggers.sql'), 'utf8');
    expect(triggers).toContain(`alphabet constant text := '${PUBLIC_CODE_ALPHABET}';`);
    expect(triggers).toContain(`floor(random() * ${PUBLIC_CODE_ALPHABET.length})`);
    expect(triggers).toContain(`FOR i IN 1..${PUBLIC_CODE_LENGTH} LOOP`);
    const columns = readFileSync(join(DRIZZLE, '0258_public_codes.sql'), 'utf8');
    for (const table of ['orders', 'payments', 'services', 'tickets']) {
      expect(columns).toContain(
        `ALTER TABLE "${table}" ADD CONSTRAINT "${table}_code_check" CHECK (code IS NULL OR code ~ '${PUBLIC_CODE_PATTERN.source}')`,
      );
    }
  });

  it('a typed code is forgiven case, spaces and a leading #, and nothing else', () => {
    expect(publicCodeFromSearch('K7M2P9QA')).toBe('K7M2P9QA');
    expect(publicCodeFromSearch('  k7m2p9qa ')).toBe('K7M2P9QA');
    expect(publicCodeFromSearch('#K7M2P9QA')).toBe('K7M2P9QA');
    expect(publicCodeFromSearch('23456789')).toBe('23456789');
    // A misread symbol is not "corrected" into somebody else's record.
    expect(publicCodeFromSearch('K7M2P9Q0')).toBeNull();
    expect(publicCodeFromSearch('K7M2P9QO')).toBeNull();
    expect(publicCodeFromSearch('7d433a363380f69e')).toBeNull();
    expect(publicCodeFromSearch('@someone')).toBeNull();
  });

  it('the accessor prints the stored code, and nothing for a row without one', () => {
    expect(orderCodeOf({ code: 'K7M2P9QA' })).toBe('K7M2P9QA');
    expect(orderCodeOf({ code: null })).toBeNull();
  });
});

describe('the product code', () => {
  it('is P- and the per-tenant number', () => {
    expect(productCode(101)).toBe('P-101');
    expect(productCode(1024)).toBe('P-1024');
  });

  it('is found from P-102, p102 and P102, never from a bare number', () => {
    expect(productCodeNumberFromSearch('P-102')).toBe(102);
    expect(productCodeNumberFromSearch(' p-102 ')).toBe(102);
    expect(productCodeNumberFromSearch('P102')).toBe(102);
    expect(productCodeNumberFromSearch('102')).toBeNull();
    expect(productCodeNumberFromSearch('P-0')).toBeNull();
    expect(productCodeNumberFromSearch('P-')).toBeNull();
    expect(productCodeNumberFromSearch('Premium')).toBeNull();
  });
});
