import type { ServiceCursor } from '../../modules/commerce/provisioning/application/ports.js';

/**
 * A keyset cursor, small enough to ride in Telegram's `callback_data`.
 *
 * ## Why not the encoding this repository already has
 *
 * `encodeKeysetCursor` base64s the cursor's JSON, which is right for an HTTP query
 * string and far too large here: Telegram caps `callback_data` at 64 BYTES, and that
 * JSON alone is about a hundred. The natural text form is no better — a `timestamptz`
 * printed to microseconds is 29 characters and a UUID is 36, so a prefix plus the pair
 * is 67 before anything else. Neither fits, which is the whole reason this file exists.
 *
 * ## What it does instead
 *
 * The timestamp becomes microseconds since the epoch in base 36, and the UUID loses its
 * dashes. That is 11 + 1 + 32 = 44 characters, so `l:` plus a token is 46 bytes with
 * eighteen to spare. `tests/unit/service-cursor.test.ts` pins that bound, because
 * nothing in the runtime enforces it — the 64-byte limit is Telegram's, discovered by a
 * rejected `answerCallbackQuery` rather than by a type error.
 *
 * ## Microsecond fidelity is the point, not a detail
 *
 * `ServiceCursor.createdAt` is PostgreSQL's own microsecond text and is deliberately not
 * a JavaScript `Date`: 4H measured what a millisecond round trip costs here, because the
 * driver TRUNCATES rather than rounds, so a cursor lands strictly outside the row it was
 * built from and the tuple comparison lets that row back in — an endless list of the
 * same page. So the encoding carries microseconds, and `decodeServiceCursor` emits a
 * literal with six fractional digits that casts back to the same instant.
 *
 * ## The range it covers, stated rather than discovered
 *
 * Microseconds since the epoch are held as a `number`, so the encodable range ends at
 * `Number.MAX_SAFE_INTEGER` microseconds — the year 2255 — and a row outside it is
 * refused rather than encoded imprecisely. A refusal here means the "more" button is not
 * drawn, which reads as a list that ends; that is the safe direction, and it is tested.
 * A `bigint` would remove the cliff and cost a hand-written base-36 parse for a bound no
 * service row will reach.
 *
 * Below the epoch is refused for the same reason: a negative count has no base-36 form
 * this decoder accepts, and a service row predating 1970 is not a thing the product can
 * produce.
 *
 * ## It is not a secret and does not need to be
 *
 * A customer can read, edit or invent one. Nothing is authorized by it: the query it
 * feeds is already scoped to the tenant and to the customer resolved from the update, so
 * the worst a forged cursor achieves is a different page of that customer's own
 * services. What it must not do is reach a `uuid` column malformed, which is why
 * decoding happens at the boundary and answers null rather than throwing.
 */

/** `YYYY-MM-DD HH:MM:SS[.ffffff][+00]`, as PostgreSQL prints a `timestamptz`. */
const POSTGRES_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2})(?::?(\d{2}))?)?$/;

/** `<base36 micros>.<32 hex digits>`, and nothing else. */
const TOKEN = /^([0-9a-z]{1,11})\.([0-9a-f]{32})$/;

function microsOf(text: string): number | null {
  const match = POSTGRES_TIMESTAMP.exec(text.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute, second, fraction, sign, offsetHours, offsetMinutes] =
    match;
  const millis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute),
    Number(second),
  );
  if (!Number.isFinite(millis)) return null;
  // Padded on the RIGHT: `.123` is 123000 microseconds, not 123.
  const micros = Number((fraction ?? '').padEnd(6, '0'));
  const offset =
    sign === undefined
      ? 0
      : (sign === '-' ? -1 : 1) * (Number(offsetHours ?? '0') * 60 + Number(offsetMinutes ?? '0'));
  const total = (millis - offset * 60_000) * 1000 + micros;
  return total < 0 || !Number.isSafeInteger(total) ? null : total;
}

/** The token for one cursor, or null if the cursor is not a shape this can carry. */
export function encodeServiceCursor(cursor: ServiceCursor): string | null {
  const micros = microsOf(cursor.createdAt);
  const id = cursor.id.replace(/-/g, '').toLowerCase();
  if (micros === null || !/^[0-9a-f]{32}$/.test(id)) return null;
  return `${micros.toString(36)}.${id}`;
}

/**
 * One cursor from a token, or null for anything else.
 *
 * Null for a malformed token, a token whose microseconds do not fit a safe integer, and
 * a token whose hex is not a UUID's worth. The caller answers the ordinary
 * unsupported-input reply, which is what every other unparseable callback gets.
 */
export function decodeServiceCursor(token: string): ServiceCursor | null {
  const match = TOKEN.exec(token);
  if (match === null) return null;
  const [, encodedMicros, hex] = match;
  const micros = Number.parseInt(encodedMicros ?? '', 36);
  if (!Number.isSafeInteger(micros) || micros < 0) return null;

  const millis = Math.floor(micros / 1000);
  const remainder = micros - millis * 1000;
  const instant = new Date(millis);
  if (Number.isNaN(instant.getTime())) return null;
  /*
   * Six fractional digits, built rather than formatted.
   *
   * `toISOString` gives three, which is exactly the truncation this encoding exists to
   * survive: the millisecond form of a cursor built from a microsecond row compares
   * strictly outside that row.
   */
  const iso = `${instant.toISOString().slice(0, -1)}${String(remainder).padStart(3, '0')}Z`;
  const bytes = hex ?? '';
  const id = [
    bytes.slice(0, 8),
    bytes.slice(8, 12),
    bytes.slice(12, 16),
    bytes.slice(16, 20),
    bytes.slice(20),
  ].join('-');
  return { createdAt: iso, id };
}
