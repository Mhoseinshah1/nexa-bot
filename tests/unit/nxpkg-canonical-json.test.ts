import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NxpkgError,
  canonicalJson,
  compareCodePoints,
  parseStrictJson,
} from '../../apps/api/src/infrastructure/nxpkg';

/**
 * `canonicalJson` / `parseStrictJson` against the converter's Python `canonical_json` /
 * `loads_strict`. The vectors in `tests/fixtures/nxpkg/expected.json` were encoded BY
 * PYTHON (`generate.py`); this file only decodes them and compares bytes.
 */
const FIXTURES = join(__dirname, '../fixtures/nxpkg');
const expected = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  canonical_vectors: { input_b64: string; canonical_b64: string }[];
};

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof NxpkgError ? `${err.code}:${err.reason}` : `other:${String(err)}`;
  }
  return 'no error';
}

describe('canonicalJson is byte-identical to the converter', () => {
  it.each(expected.canonical_vectors.map((v, i) => [i, v] as const))(
    'Python vector %i',
    (_i, v) => {
      const value = parseStrictJson(Buffer.from(v.input_b64, 'base64'));
      expect(canonicalJson(value).toString('base64')).toBe(v.canonical_b64);
    },
  );

  it('sorts keys by code point, not by UTF-16 unit', () => {
    // U+1F600 is a surrogate pair (0xD83D…) in UTF-16, below U+E000 there, above it in Python.
    const keys = ['\u{1F600}', '￿', '', 'a'];
    expect([...keys].sort(compareCodePoints)).toEqual(['a', '', '￿', '\u{1F600}']);
    expect(canonicalJson({ '\u{1F600}': 1, '': 2 }).toString('utf8')).toBe(
      '{"":2,"\u{1F600}":1}',
    );
  });

  it('writes non-ASCII raw and escapes only quote, backslash and C0 controls', () => {
    expect(canonicalJson({ s: 'میرزا \x7f"\\\n\x01' }).toString('utf8')).toBe(
      '{"s":"میرزا \x7f\\"\\\\\\n\\u0001"}',
    );
  });

  it('refuses what Python refuses, instead of coercing it', () => {
    for (const bad of [1.5, NaN, Infinity, -Infinity, 2 ** 53, undefined, () => 1, new Date(0)]) {
      expect(() => canonicalJson({ v: bad })).toThrow(TypeError);
    }
    expect(() => canonicalJson('\ud800')).toThrow(TypeError);
    expect(() => canonicalJson({ ['\udc00']: 1 })).toThrow(TypeError);
    expect(canonicalJson(-0).toString()).toBe('0');
    expect(canonicalJson(2n ** 70n).toString()).toBe('1180591620717411303424');
  });

  it('nests at most 200 levels, like the Python normaliser', () => {
    let ok: unknown = 1;
    for (let i = 0; i < 200; i++) ok = [ok];
    expect(() => canonicalJson(ok)).not.toThrow();
    expect(() => canonicalJson([ok])).toThrow(TypeError);
  });
});

describe('parseStrictJson follows loads_strict', () => {
  it('rejects float literals and NaN/Infinity, wherever they are', () => {
    expect(codeOf(() => parseStrictJson('{"a":1.0}'))).toBe(
      'NXPKG_CONTAINER_INVALID:json_float_literal',
    );
    expect(codeOf(() => parseStrictJson('[1e3]'))).toBe(
      'NXPKG_CONTAINER_INVALID:json_float_literal',
    );
    expect(codeOf(() => parseStrictJson('[0E0]'))).toBe(
      'NXPKG_CONTAINER_INVALID:json_float_literal',
    );
    expect(codeOf(() => parseStrictJson('{"a":NaN}'))).toBe('NXPKG_CONTAINER_INVALID:json_syntax');
    expect(codeOf(() => parseStrictJson('[Infinity]'))).toBe('NXPKG_CONTAINER_INVALID:json_syntax');
  });

  it('does not mistake a dot or an e inside a string for a number', () => {
    expect(parseStrictJson('{"a.b":"1.5e3","t":true,"f":false,"n":-12}')).toEqual({
      'a.b': '1.5e3',
      t: true,
      f: false,
      n: -12,
    });
    expect(parseStrictJson('["\\"1.0", 2]')).toEqual(['"1.0', 2]);
  });

  it('refuses an integer a JavaScript number would round, and accepts the largest safe one', () => {
    expect(parseStrictJson('[9007199254740991,-9007199254740991,123456789012345]')).toEqual([
      9007199254740991, -9007199254740991, 123456789012345,
    ]);
    expect(codeOf(() => parseStrictJson('[9007199254740993]'))).toBe(
      'NXPKG_CONTAINER_INVALID:json_unsafe_integer',
    );
  });

  it('reads -0 as 0, as Python does', () => {
    expect(Object.is(parseStrictJson('-0'), 0)).toBe(true);
    expect(Object.is((parseStrictJson('{"a":-0}') as { a: number }).a, 0)).toBe(true);
  });

  it('keeps the last value of a duplicated key, as json.loads does', () => {
    expect(parseStrictJson('{"a":1,"a":2}')).toEqual({ a: 2 });
  });

  it('refuses invalid UTF-8 and a byte-order mark', () => {
    expect(codeOf(() => parseStrictJson(Buffer.from([0x22, 0xff, 0x22])))).toBe(
      'NXPKG_CONTAINER_INVALID:json_not_utf8',
    );
    expect(codeOf(() => parseStrictJson(Buffer.from('﻿{}', 'utf8')))).toBe(
      'NXPKG_CONTAINER_INVALID:json_syntax',
    );
  });

  it('a __proto__ key is data, not a prototype', () => {
    const v = parseStrictJson('{"__proto__":{"x":1}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__']);
    expect(canonicalJson(v).toString()).toBe('{"__proto__":{"x":1}}');
  });
});
