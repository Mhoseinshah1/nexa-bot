import pg from 'pg';

/**
 * node-postgres returns `int8` and `numeric` as JavaScript strings by default,
 * because neither fits in a `number` without losing precision. That default is
 * correct and we keep it — but it must be a deliberate, tested decision rather
 * than something discovered later by a wrong balance.
 *
 * `int8` is parsed to `bigint` so money columns arrive as bigint end to end.
 * `numeric` stays a string: it is arbitrary-precision decimal and any numeric
 * JS type would silently narrow it.
 *
 * Call once, before the first pool is created.
 */

const OID_INT8 = 20;
const OID_NUMERIC = 1700;

let applied = false;

export function applyPgTypeParsers(): void {
  if (applied) return;
  applied = true;

  pg.types.setTypeParser(OID_INT8, (value: string) => BigInt(value));
  pg.types.setTypeParser(OID_NUMERIC, (value: string) => value);
}

/** Exposed so a test can assert the parsers are actually registered. */
export const PG_PARSED_OIDS = { int8: OID_INT8, numeric: OID_NUMERIC } as const;
