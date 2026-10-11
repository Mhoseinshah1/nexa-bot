import { containerInvalid } from './errors.js';

/**
 * Canonical JSON, byte-identical to the converter's `mirza2nexa/nxpkg/canonical.py`:
 *
 *   json.dumps(v, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
 *              allow_nan=False).encode("utf-8")
 *
 * after a normalisation pass that rejects floats and nests at most 200 levels.
 *
 * What makes the two agree, case by case:
 *
 *   - **Key order** is Python's `str` order, i.e. Unicode CODE POINT order. JavaScript's
 *     default sort compares UTF-16 code units, which disagrees for a key holding a
 *     character above U+FFFF against one in U+E000..U+FFFF; `compareCodePoints` fixes that.
 *   - **Strings**: with `ensure_ascii=False` Python escapes exactly `"` `\` and U+0000..U+001F
 *     (`\b \f \n \r \t` short, the rest `\u00xx` lowercase) and writes everything else raw,
 *     U+2028/U+2029 and U+007F included. `JSON.stringify` does the same for a well-formed
 *     string. A lone surrogate is refused: Python cannot encode one to UTF-8, and
 *     `JSON.stringify` would escape it instead, so the two would differ.
 *   - **Numbers**: integers only. Python ints are unbounded; here a `number` must be a safe
 *     integer (a larger one is not exactly representable) and a `bigint` is written in full.
 *     A non-integer, NaN or ±Infinity is refused, as Python refuses a float. `-0` is `0`.
 *   - **Types**: `null`, booleans, strings, numbers/bigints, arrays and plain objects.
 *     `undefined`, functions, symbols, `Date`, `Map`, `Buffer` and other class instances are
 *     refused rather than silently dropped or coerced the way `JSON.stringify` would.
 *   - Python's `Decimal` (written as `str(Decimal)`) has no TypeScript counterpart; a
 *     decimal must be passed as the string Python would have produced.
 */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(canonicalJsonString(value), 'utf8');
}

export function canonicalJsonString(value: unknown): string {
  return encode(value, 0);
}

const MAX_DEPTH = 200;
const LONE_SURROGATE = /\p{Cs}/u;

function encode(v: unknown, depth: number): string {
  if (depth > MAX_DEPTH) throw new TypeError('canonicalJson: nesting too deep');
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return encodeString(v);
    case 'number':
      if (!Number.isSafeInteger(v)) {
        throw new TypeError('canonicalJson: only safe integers are allowed (no floats)');
      }
      return v === 0 ? '0' : String(v);
    case 'bigint':
      return v.toString(10);
    case 'object':
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof v}`);
  }
  if (Array.isArray(v)) {
    return `[${v.map((x: unknown) => encode(x, depth + 1)).join(',')}]`;
  }
  const proto: unknown = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    throw new TypeError('canonicalJson: only plain objects are allowed');
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort(compareCodePoints);
  const parts: string[] = [];
  for (const k of keys) {
    parts.push(`${encodeString(k)}:${encode(obj[k], depth + 1)}`);
  }
  return `{${parts.join(',')}}`;
}

function encodeString(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new TypeError('canonicalJson: lone surrogate in string');
  return JSON.stringify(s);
}

/** Order two strings by Unicode code point, as Python compares `str`. */
export function compareCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.charCodeAt(i);
    const y = b.charCodeAt(i);
    if (x === y) continue;
    const xs = x >= 0xd800 && x <= 0xdfff;
    const ys = y >= 0xd800 && y <= 0xdfff;
    // A surrogate stands for a code point >= U+10000, above every BMP unit it differs from.
    if (xs && !ys) return y >= 0xe000 ? 1 : x - y;
    if (ys && !xs) return x >= 0xe000 ? -1 : x - y;
    return x - y;
  }
  return a.length - b.length;
}

// --------------------------------------------------------------------------- strict parse

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const INTEGER_SOURCE = /^-?(?:0|[1-9][0-9]*)$/;

type ReviverContext = { source?: string };

/**
 * Parse JSON the way the converter's `loads_strict` does, failing closed where JavaScript
 * cannot represent what Python would accept.
 *
 *   - bytes are strict UTF-8 (an invalid sequence or a leading BOM is refused, as Python's
 *     `bytes.decode("utf-8")` + `json.loads` refuses them);
 *   - a number literal with a fraction or an exponent (`1.0`, `1e3`) is refused, as
 *     `parse_float` refuses it; NaN/Infinity are not JSON and are refused;
 *   - an integer outside ±(2^53-1) is refused. Python would accept it, but a JavaScript
 *     number would silently round it — a different value is worse than no value;
 *   - a duplicated object key keeps the LAST value, exactly as Python's `json.loads` does.
 *
 * Throws `NxpkgError(NXPKG_CONTAINER_INVALID)`; callers that know the bytes were
 * authenticated or checksummed remap it.
 */
export function parseStrictJson(data: Uint8Array | string): unknown {
  let text: string;
  if (typeof data === 'string') {
    text = data;
  } else {
    try {
      text = UTF8.decode(data);
    } catch {
      throw containerInvalid('json_not_utf8');
    }
  }
  if (!needsReviver(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw containerInvalid('json_syntax');
    }
  }
  let bad: string | null = null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (_key: string, value: unknown, ...rest: unknown[]): unknown => {
      if (typeof value === 'number') {
        // `context.source` (JSON.parse source text access) is the literal as written.
        const ctx = rest[0] as ReviverContext | undefined;
        const src = ctx?.source;
        if (src === undefined) {
          bad = 'json_number_source_unavailable';
        } else if (!INTEGER_SOURCE.test(src)) {
          bad = 'json_float_literal';
        } else if (!Number.isSafeInteger(value)) {
          bad = 'json_unsafe_integer';
        }
        return value === 0 ? 0 : value;
      }
      return value;
    });
  } catch {
    throw containerInvalid('json_syntax');
  }
  if (bad !== null) throw containerInvalid(bad);
  return parsed;
}

/**
 * True when the text might hold a number `JSON.parse` alone cannot judge: a fraction or
 * exponent, 16 or more digits (possibly beyond 2^53), or `-0`. False means every number
 * literal outside a string is a plain integer of at most 15 digits, so the reviver — about
 * six times slower — is not needed. Only consulted for text that then has to parse as JSON,
 * so it can assume a well-formed string syntax.
 */
function needsReviver(text: string): boolean {
  let inString = false;
  let digits = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
      continue;
    }
    if (c === 0x22) {
      inString = true;
      digits = 0;
      continue;
    }
    if (c >= 0x30 && c <= 0x39) {
      if (++digits > 15) return true;
      continue;
    }
    if (c === 0x2e || ((c === 0x65 || c === 0x45) && digits > 0)) return true;
    if (c === 0x2d && text.charCodeAt(i + 1) === 0x30) return true;
    digits = 0;
  }
  return false;
}
