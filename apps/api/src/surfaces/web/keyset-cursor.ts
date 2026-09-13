import { CONTROL_ERROR_CODES, errors, isStorableInstant } from '@nexa/contracts';

/**
 * The one keyset cursor this surface speaks.
 *
 * Extracted from `panels.controller.ts`, where it was written and then corrected
 * four times; `/users` needed the same thing and the instruction in `CLAUDE.md`
 * about `probe-core.ts` applies word for word — "never copy it; the copy that
 * would silently keep the old behaviour is the unattended one". A second copy of
 * this function would be the one that still restarts the traversal on a cursor
 * it cannot read, because that is the version every one of the four corrections
 * started from.
 *
 * Deliberately NOT general. It knows exactly one shape — `(created_at, id)`
 * where `id` is a uuid and `created_at` is PostgreSQL's own microsecond
 * rendering — because both of its two callers page an append-only `created_at`
 * with a uuid tiebreak, and a parameterised key order would be a configuration
 * surface for a decision neither caller gets to make. When a third collection
 * needs a different key, it adds a sibling rather than a type parameter here.
 */

/**
 * The cursor, opaque across the wire.
 *
 * Base64url of `(id, created_at)`. Opaque on purpose: a caller that parsed it
 * would be depending on an ordering this API has not promised, and would break
 * the day the list is ordered differently.
 *
 * A cursor that does not decode is a 400. The rule used to be the opposite —
 * "treated as no cursor rather than an error… refusing would turn a stale
 * bookmark into a failed request" — and that sentence survived one commit past
 * the owner inverting it, two screens above the function that refuses. Restated
 * here rather than deleted, because it is exactly the argument a later reader
 * would use to put the silent restart back.
 *
 * EVERY component is validated, and that is the point rather than tidiness.
 * The decoded id goes into a query that casts it to `uuid`, so `not-a-uuid`
 * reached PostgreSQL as 22P02 and came back as a 500 — a caller could turn any
 * text into an internal error by base64ing it.
 */
const CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The exact rendering the page key queries produce, and nothing else.
 *
 * The four-digit year bounds the SHAPE. It does NOT bound the range, which is
 * what this block claimed for one release: `0000-01-01T00:00:00.000000Z` has
 * four digits, parses, and raises `22008` at the `::timestamptz` cast, because
 * PostgreSQL has no year zero. The range is `isStorableInstant`'s, in the
 * contract, shared with `/ops-log` and `/notifications` — three cursors that
 * each grew their own copy of this rule and were each wrong somewhere.
 */
const CURSOR_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.\d{6}Z$/;

/**
 * Where a page ended: the ordering key, not an offset.
 *
 * `createdAt` is the stored `created_at` as PostgreSQL's OWN text, never as a
 * `Date`. `timestamptz` keeps microseconds and a JavaScript `Date` keeps
 * milliseconds, and the driver TRUNCATES rather than rounds — so a cursor built
 * from a `Date` is strictly BELOW the row it was built from whenever that row's
 * microseconds are non-zero, the tuple comparison lets that row back in, and at
 * `limit=1` the traversal never ends because every page returns the same row and
 * hands back the same cursor. Both repositories render it with `to_char` and
 * compare it with an explicit `::timestamptz`, so the value that comes out is
 * the value that goes back in.
 */
export interface KeysetPosition {
  readonly createdAt: string;
  readonly id: string;
}

export function encodeKeysetCursor(cursor: KeysetPosition): string {
  return Buffer.from(`${cursor.id}:${cursor.createdAt}`, 'utf8').toString('base64url');
}

/** The timestamp half, or null if PostgreSQL would refuse it. */
function decodeInstant(text: string): string | null {
  const parts = CURSOR_INSTANT.exec(text);
  if (parts === null) return null;
  const at = new Date(
    `${parts[1]}-${parts[2]}-${parts[3]}T${parts[4]}:${parts[5]}:${parts[6]}.000Z`,
  );
  // The RANGE, from the contract. `Number.isNaN` was the whole check here and
  // let year 0000 through to the driver.
  if (!isStorableInstant(at)) return null;
  // A date JavaScript silently ROLLS OVER — `2026-02-30` becomes 2 March —
  // and PostgreSQL refuses outright. The regex cannot see that, so the value
  // is compared with what it parsed to.
  if (at.toISOString().slice(0, 19) !== text.slice(0, 19)) return null;
  return text;
}

/**
 * A cursor this server did not mint is a 400. It never restarts the traversal.
 *
 * This function used to return `null` for every unreadable cursor, and a null
 * cursor drops the keyset predicate — so `GET /panels?cursor=<anything>`
 * answered **200 with page one**. A client that truncated or invented a cursor
 * looped on the first page for ever and was never told, and the Web Admin's own
 * docblock promised the opposite: "the server rejects a cursor it did not mint,
 * so a clever client-side cursor is a 400 rather than a subtle bug". It was the
 * only one of the three cursors in this codebase that behaved that way;
 * `/ops-log` and `/notifications` have always refused, and their comment gives
 * this exact looping as the reason.
 *
 * The owner resolved it: ONE house rule, and it is refusal. Absent means the
 * first page, valid means the next page, and anything else is
 * `control.invalid_value` with a 400 — never a successful-looking answer to a
 * question the caller did not ask.
 *
 * The old argument for restarting was that refusing a legal-but-unknown id
 * "would restart the traversal for ever rather than fail it, which is the worse
 * outcome". That reasoning is now inverted deliberately: failing loudly once is
 * strictly better than looping silently, because the loop is invisible to
 * everyone including the operator watching it.
 *
 * Note what this does NOT do: it does not bind the cursor to a tenant. The
 * position it decodes is an opaque pair, and every caller passes it to a
 * repository whose WHERE clause already has `tenant_id = $scope`, so tenant A's
 * cursor replayed in tenant B selects within tenant B and finds nothing of A's —
 * an empty page, not a leak. Binding the tenant into the ciphertext would move
 * that guarantee from the query, where it is enforced once for every predicate,
 * into a string a future caller could forget to check. The integration suite
 * asserts the replay answers with B's rows only.
 */
export function decodeKeysetCursor(raw: string): KeysetPosition {
  // Built rather than thrown, so every `throw` below is visible to the reader
  // AND to the compiler: a helper that throws is not a narrowing point unless
  // it is typed `never`, and `throw bad(...)` needs neither the annotation nor
  // the casts that came with it.
  const bad = (why: string): Error =>
    errors.validation(CONTROL_ERROR_CODES.INVALID_VALUE, `The \`cursor\` ${why}.`, {
      // A TRUNCATED echo. A 400 body is not a place to reflect an unbounded
      // string a caller controls.
      cursor: raw.length > 64 ? `${raw.slice(0, 64)}…` : raw,
    });
  /*
   * NO length bound here, deliberately, and no `try` around the decode.
   *
   * Both were written, and both were dead. The query schema bounds `cursor` at
   * `z.string().max(512)`, so a longer value is a `ZodError` and a 400 before
   * this function is reached — the branch that claimed to stop "a megabyte of
   * base64" could not fire, and its comment described a path that no longer
   * existed. And `Buffer.from(text, 'base64url')` never throws for any string:
   * it SKIPS characters it cannot decode, so the `catch` was unreachable, and
   * `'!!!not base64!!!'` was refused for having no separator rather than by
   * the guard the fixture was written for. That same skipping also meant a
   * cursor with junk inserted, appended or padded decoded to the ORIGINAL
   * tuple and was answered with a 200 — a value this server never issued,
   * accepted, against the rule stated two paragraphs up. So the decoded bytes
   * are re-encoded and must reproduce `raw` exactly: `encodeKeysetCursor` emits
   * unpadded base64url, and anything that is not byte-for-byte that spelling
   * is not ours, whatever it happens to decode to.
   *
   * One bound, in the schema, which is also where the wire contract states it.
   * The cost of that arrangement is stated rather than glossed: an oversize
   * cursor is refused with `request.invalid` and every other unreadable one
   * with `control.invalid_value`. Both are 400s a client can act on, they are
   * asserted separately so the two cannot swap unnoticed, and `http.ts` says
   * so where the rule is declared.
   */
  const bytes = Buffer.from(raw, 'base64url');
  if (bytes.toString('base64url') !== raw) throw bad('is not a cursor this server issued');
  const decoded = bytes.toString('utf8');
  const separator = decoded.indexOf(':');
  // The empty cursor arrives here too. `Buffer.from('', 'base64url')` is empty
  // and `''.indexOf(':')` is -1, so this line refuses `?cursor=` with the same
  // message a `raw.length === 0` branch above it used to produce — a THIRD
  // line of the same class as the two an earlier round removed, written in
  // the same function, and no test could tell whether it existed.
  if (separator === -1) throw bad('is not a cursor this server issued');
  const id = decoded.slice(0, separator);
  // Any UUID version, not v7 specifically: the only thing this value has to be
  // is a legal `uuid` literal, because it reaches a `uuid` column and a
  // malformed one was a driver error and a 500.
  //
  // The message says CANNOT BE READ, never "names no row": a well-formed uuid
  // at a well-formed instant naming nothing is the 200-with-an-empty-page case,
  // and a message that called this refusal "does not name a row" told the
  // client the opposite of the boundary the code draws.
  if (!CURSOR_UUID.test(id)) throw bad('does not carry an identifier this server issues');
  const createdAt = decodeInstant(decoded.slice(separator + 1));
  if (createdAt === null) throw bad('does not carry a position this server issues');
  return { id: id.toLowerCase(), createdAt };
}
