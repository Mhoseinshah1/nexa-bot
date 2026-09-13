import { describe, expect, it } from 'vitest';
import { CONTROL_ERROR_CODES } from '@nexa/contracts';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
} from '../../apps/api/src/surfaces/web/keyset-cursor';

/**
 * The cursor, pinned after the extraction.
 *
 * `panels.controller.ts` held this code, had it corrected four times, and was
 * the only place it existed. `/users` needed the same thing, so it was MOVED —
 * and `CLAUDE.md` is explicit about what a move has to prove: "what does this
 * fix now do that it did not do before, and in which state is that wrong?" An
 * extraction whose only evidence is a green suite proves nothing if no test
 * could tell two versions of the function apart.
 *
 * So this file asserts the EXACT strings and the EXACT refusals, not that
 * something happened. Every expected value below was produced by the
 * pre-extraction `panels.controller.ts` and is written out literally rather
 * than recomputed with the function under test, because a test that encodes
 * with `encodeKeysetCursor` and decodes with `decodeKeysetCursor` passes for
 * any pair of mutually consistent implementations, including a wrong one.
 *
 * `tests/integration/panels-http.test.ts` covers the same rules end to end
 * over real HTTP with 18 malformed shapes; this is the half that runs in
 * `pnpm verify` with no database.
 */

const ID = '018f3a2b-4c5d-7e8f-9a0b-1c2d3e4f5a6b';
const AT = '2026-03-04T05:06:07.123456Z';
/**
 * Produced by the pre-extraction `encodeCursor`, transcribed.
 *
 * Unpadded base64url of `${id}:${createdAt}`. Written literally so a change to
 * the encoding — padding, a different separator, the two halves swapped — fails
 * here rather than round-tripping happily through its own inverse.
 */
const ENCODED =
  'MDE4ZjNhMmItNGM1ZC03ZThmLTlhMGItMWMyZDNlNGY1YTZiOjIwMjYtMDMtMDRUMDU6MDY6MDcuMTIzNDU2Wg';

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url');

function refusal(raw: string): { code: string; message: string; cursor: unknown } {
  try {
    decodeKeysetCursor(raw);
  } catch (error) {
    const shaped = error as {
      code?: string;
      message?: string;
      details?: Record<string, unknown>;
    };
    return {
      code: shaped.code ?? '(no code)',
      message: shaped.message ?? '(no message)',
      cursor: shaped.details?.['cursor'],
    };
  }
  throw new Error(`decodeKeysetCursor accepted ${JSON.stringify(raw)}`);
}

describe('the keyset cursor, as Panels produced it before the extraction', () => {
  it('encodes to the exact bytes the pre-extraction controller emitted', () => {
    expect(encodeKeysetCursor({ id: ID, createdAt: AT })).toBe(ENCODED);
    // Unpadded, which is what the re-encode check below depends on: a padded
    // spelling of the same tuple must be refused, so this encoder must never
    // produce one.
    expect(ENCODED.endsWith('=')).toBe(false);
  });

  it('decodes that exact string back to the same pair', () => {
    expect(decodeKeysetCursor(ENCODED)).toEqual({ id: ID, createdAt: AT });
  });

  it('lower-cases the id half, because the column is `uuid`', () => {
    const upper = b64(`${ID.toUpperCase()}:${AT}`);
    expect(decodeKeysetCursor(upper)).toEqual({ id: ID, createdAt: AT });
  });

  it('keeps the instant as TEXT, never as a Date', () => {
    const decoded = decodeKeysetCursor(ENCODED);
    // The microseconds are the point. A `Date` here truncates `.123456` to
    // `.123`, the keyset comparison then sits strictly below the row the cursor
    // names, that row returns on the next page, and at `limit=1` the traversal
    // never ends. Asserted on the type AND the value.
    expect(typeof decoded.createdAt).toBe('string');
    expect(decoded.createdAt).toBe('2026-03-04T05:06:07.123456Z');
  });

  /**
   * The refusals, by the exact message each shape got.
   *
   * Three distinct messages, and which one a shape gets is asserted rather than
   * merely that something was thrown. The extraction could have collapsed them
   * into one without any other test noticing, and the three are what tell an
   * operator reading a 400 whether the id or the position was the problem.
   */
  it.each([
    // Not base64url at all: `Buffer.from` SKIPS what it cannot decode, so this
    // is caught by the re-encode check, not by a throw.
    ['!!!not base64!!!', 'is not a cursor this server issued'],
    // Decodes, but has no separator.
    [b64('nothing-to-split-on'), 'is not a cursor this server issued'],
    // Empty. `Buffer.from('', 'base64url')` is empty and `''.indexOf(':')` is
    // -1, so the separator line refuses it.
    ['', 'is not a cursor this server issued'],
    // An empty id.
    [b64(`:${AT}`), 'does not carry an identifier this server issues'],
    // The shape of the original 500: an id that is not a uuid reached a `uuid`
    // column as 22P02.
    [b64(`not-a-uuid:${AT}`), 'does not carry an identifier this server issues'],
    [b64(`../../etc/passwd:${AT}`), 'does not carry an identifier this server issues'],
    // A real uuid with a timestamp that is not one.
    [b64(`${ID}:not-a-time`), 'does not carry a position this server issues'],
    [b64(`${ID}:`), 'does not carry a position this server issues'],
    // In range for a JavaScript Date and OUT of range for `timestamptz`, which
    // raises 22008 at the cast — the same 500 by another route.
    [b64(`${ID}:-005000-01-01T00:00:00.000000Z`), 'does not carry a position this server issues'],
    [b64(`${ID}:275760-09-13T00:00:00.000000Z`), 'does not carry a position this server issues'],
    // YEAR ZERO. Four digits, so the shape regex passes it, and PostgreSQL has
    // no year zero — the one four-digit rendering it refuses, and the one the
    // "the four-digit year is load-bearing" docblock did not cover.
    [b64(`${ID}:0000-01-01T00:00:00.000000Z`), 'does not carry a position this server issues'],
    // Dates JavaScript rolls over and PostgreSQL refuses.
    [b64(`${ID}:2026-02-30T00:00:00.000000Z`), 'does not carry a position this server issues'],
    [b64(`${ID}:2026-13-01T00:00:00.000000Z`), 'does not carry a position this server issues'],
    // The right shape, the wrong precision: this API issues microseconds.
    [b64(`${ID}:2026-01-01T00:00:00.000Z`), 'does not carry a position this server issues'],
    // TRUNCATED — a real cursor with its tail cut off, which is the shape a
    // client actually produces. It is refused by the RE-ENCODE check rather
    // than by the instant check, because cutting 43 characters off an unpadded
    // base64url string leaves a trailing group whose spare bits are non-zero,
    // so the bytes do not re-encode to themselves. Recorded as the check that
    // actually fires rather than the one that reads more natural: a test that
    // named the instant check here would keep passing if the re-encode check
    // were deleted, and the re-encode check is the one that closed the
    // junk-appended 200.
    [ENCODED.slice(0, Math.floor(ENCODED.length / 2)), 'is not a cursor this server issued'],
    // NONCANONICAL spellings of a REAL cursor. `Buffer.from(x, 'base64url')`
    // skips characters it cannot decode, so each of these decoded to the
    // original tuple and was answered with a 200 — a value this server never
    // issued, accepted.
    [`${ENCODED}!`, 'is not a cursor this server issued'],
    [`${ENCODED.slice(0, 4)}*${ENCODED.slice(4)}`, 'is not a cursor this server issued'],
    [`${ENCODED}=`, 'is not a cursor this server issued'],
  ])('refuses %j', (raw, why) => {
    const { code, message } = refusal(raw as string);
    expect(code).toBe(CONTROL_ERROR_CODES.INVALID_VALUE);
    expect(message).toBe(`The \`cursor\` ${why}.`);
  });

  it('never restarts the traversal, for any of those shapes', () => {
    /*
     * The inverted rule, asserted as an absence.
     *
     * This function used to return `null` for every unreadable cursor, a null
     * cursor drops the keyset predicate, and `GET /panels?cursor=<anything>`
     * answered 200 with page one — so a client that truncated or invented a
     * cursor looped on the first page for ever and was never told. There is no
     * `null` return any more, and the type says so; this says it at runtime,
     * which is the part a future `catch { return null }` would break.
     */
    for (const raw of ['', '!!!', b64('x'), `${ENCODED}=`]) {
      expect(() => decodeKeysetCursor(raw)).toThrow();
    }
  });

  it('truncates the echoed cursor at 64 characters', () => {
    // A 400 body is not a place to reflect an unbounded caller-controlled
    // string. The bound is asserted on both sides of itself.
    const short = 'a'.repeat(64);
    expect(refusal(short).cursor).toBe(short);
    const long = 'a'.repeat(65);
    expect(refusal(long).cursor).toBe(`${'a'.repeat(64)}…`);
  });

  it('accepts a decodable position that names no row — that is an empty page, not a 400', () => {
    // "Syntactically decodable but invalid" is where the rule says 400; a
    // well-formed uuid at a well-formed instant naming nothing is NOT that
    // case. It decodes, the query finds nothing, and the caller gets 200 with
    // an empty page. Asserted here so a future "does it name a row" check
    // cannot be added without this failing.
    const unknown = b64(`00000000-0000-4000-8000-000000000000:1999-12-31T23:59:59.999999Z`);
    expect(decodeKeysetCursor(unknown)).toEqual({
      id: '00000000-0000-4000-8000-000000000000',
      createdAt: '1999-12-31T23:59:59.999999Z',
    });
  });
});
