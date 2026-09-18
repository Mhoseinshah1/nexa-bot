import { describe, expect, it } from 'vitest';
import {
  decodeKeysetToken,
  encodeKeysetToken,
} from '../../apps/api/src/surfaces/telegram/keyset-token.js';
import { SERVICES_PAGE_CALLBACK_PREFIX } from '../../apps/api/src/surfaces/telegram/bot-runtime.js';
import type { ServiceCursor } from '../../apps/api/src/modules/commerce/provisioning/application/ports.js';

/**
 * The cursor that has to fit in a Telegram button.
 *
 * Two properties, and the file exists for both. It must SURVIVE the round trip at
 * microsecond precision, because 4H measured what losing the last three digits costs —
 * the cursor lands strictly outside the row it was built from and that row comes back,
 * forever. And the token must fit in 64 bytes beside a prefix, because Telegram's cap is
 * enforced by a rejected request rather than by anything in this codebase.
 */

const CURSOR: ServiceCursor = {
  createdAt: '2026-09-18 15:04:05.123456+00',
  id: '019930cd-cdef-7012-8345-6789abcdef01',
};

const micros = (text: string): number => {
  const token = encodeKeysetToken({ ...CURSOR, createdAt: text });
  if (token === null) throw new Error(`did not encode: ${text}`);
  return Number.parseInt(token.split('.')[0] ?? '', 36);
};

describe('the Telegram service cursor', () => {
  it('round-trips a PostgreSQL microsecond timestamp to the same instant', () => {
    const token = encodeKeysetToken(CURSOR);
    expect(token).not.toBeNull();
    const back = decodeKeysetToken(token ?? '');
    expect(back).not.toBeNull();
    expect(back?.id).toBe(CURSOR.id);
    /*
     * The same INSTANT, compared as one rather than as text: the encoding deliberately
     * normalises `2026-09-18 15:04:05.123456+00` to an ISO literal, and what has to
     * hold is that both cast to the same `timestamptz`.
     */
    expect(Date.parse(back?.createdAt ?? '')).toBe(Date.parse('2026-09-18T15:04:05.123Z'));
    expect(back?.createdAt).toContain('.123456');
  });

  it('keeps the last three microsecond digits, which a millisecond round trip loses', () => {
    /*
     * The rule the whole file is for. `2026-01-01T00:00:00.000123Z` and
     * `...00.000000Z` are 123 microseconds apart and the keyset comparison is strict,
     * so an encoding that dropped them would place the cursor before the row it came
     * from — and `services-http.test.ts` holds the HTTP-side measurement of exactly
     * that becoming an endless list.
     */
    const precise = decodeKeysetToken(
      encodeKeysetToken({ ...CURSOR, createdAt: '2026-01-01 00:00:00.000123+00' }) ?? '',
    );
    const truncated = decodeKeysetToken(
      encodeKeysetToken({ ...CURSOR, createdAt: '2026-01-01 00:00:00+00' }) ?? '',
    );
    expect(precise?.createdAt).not.toBe(truncated?.createdAt);
    expect(micros('2026-01-01 00:00:00.000123+00') - micros('2026-01-01 00:00:00+00')).toBe(123);
  });

  it('fits in 64 bytes with its prefix, with room to spare', () => {
    /*
     * The bound Telegram enforces and this codebase does not. Measured on the widest
     * realistic timestamp rather than on the fixture: a base-36 microsecond count stays
     * eleven characters until the year 4453.
     */
    for (const createdAt of [
      '2026-09-18 15:04:05.123456+00',
      '1970-01-01 00:00:00.000001+00',
      /* The widest the encoding accepts. See the range note in `keyset-token.ts`. */
      '2255-06-05 03:47:34.740991+00',
    ]) {
      const token = encodeKeysetToken({ ...CURSOR, createdAt });
      expect(token, createdAt).not.toBeNull();
      const data = `${SERVICES_PAGE_CALLBACK_PREFIX}${token ?? ''}`;
      expect(Buffer.byteLength(data, 'utf8'), `${createdAt} -> ${data}`).toBeLessThanOrEqual(64);
    }
  });

  it('reads the fraction as microseconds, padded on the right', () => {
    /* `.123` is 123000 microseconds. Reading it as 123 would be a 999-fold error. */
    expect(micros('2026-01-01 00:00:00.123+00') - micros('2026-01-01 00:00:00+00')).toBe(123_000);
    expect(micros('2026-01-01 00:00:00.000123+00') - micros('2026-01-01 00:00:00+00')).toBe(123);
  });

  it('applies a non-UTC offset rather than ignoring it', () => {
    /*
     * PostgreSQL prints a `timestamptz` in the session's zone, and a cursor that
     * dropped the offset would be hours away from the row — in the direction that skips
     * rows rather than repeating them, which is the silent one.
     */
    expect(micros('2026-01-01 03:30:00+03:30')).toBe(micros('2026-01-01 00:00:00+00'));
    expect(micros('2025-12-31 19:00:00-05')).toBe(micros('2026-01-01 00:00:00+00'));
  });

  it('refuses a token it did not produce, rather than guessing', () => {
    /*
     * Attacker-supplied: `callback_data` is client text. Every one of these must answer
     * null so the boundary can reply with the ordinary unsupported message, and none of
     * them may reach a `uuid` column.
     */
    for (const bad of [
      '',
      'not-a-token',
      'zzz',
      '.019930cdcdef70128345 6789abcdef01',
      `${'z'.repeat(12)}.019930cdcdef7012834567890abcdef0`,
      'abc.019930cdcdef70128345', // too few hex digits
      'abc.019930cdcdef701283456789abcdef01ff', // too many
      'ABC.019930cdcdef70128345678abcdef012', // uppercase base36
      '-1.019930cdcdef70128345678abcdef012',
    ]) {
      expect(decodeKeysetToken(bad), bad).toBeNull();
    }
  });

  it('refuses to encode an id that is not a uuid, or a timestamp it cannot read', () => {
    expect(encodeKeysetToken({ createdAt: CURSOR.createdAt, id: 'nope' })).toBeNull();
    expect(encodeKeysetToken({ createdAt: 'whenever', id: CURSOR.id })).toBeNull();
    /* A pre-epoch row is refused rather than encoded as a negative count. */
    expect(encodeKeysetToken({ createdAt: '1969-12-31 23:59:59+00', id: CURSOR.id })).toBeNull();
  });

  it('refuses a timestamp past the safe-integer range rather than encoding it imprecisely', () => {
    /*
     * The stated bound, asserted. Microseconds are a `number`, so the range ends in
     * 2255; past it the count is no longer exact and a cursor that is approximately
     * right is a cursor that skips or repeats a row. Refusing means the "more" button
     * is not drawn, which reads as a list that ends — the safe direction of the two.
     */
    expect(encodeKeysetToken({ createdAt: '2300-01-01 00:00:00+00', id: CURSOR.id })).toBeNull();
    expect(
      encodeKeysetToken({ createdAt: '2255-06-05 03:47:34+00', id: CURSOR.id }),
    ).not.toBeNull();
  });

  it('gives back a dashed uuid, the shape the query casts', () => {
    const back = decodeKeysetToken(encodeKeysetToken(CURSOR) ?? '');
    expect(back?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });
});
