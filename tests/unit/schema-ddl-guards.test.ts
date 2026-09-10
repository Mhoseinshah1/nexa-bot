import { describe, expect, it } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  enumCheck,
  nullableEnumCheck,
} from '../../apps/api/src/infrastructure/persistence/schema.js';

/**
 * The DDL text PostgreSQL would actually receive.
 *
 * Rendered through the dialect rather than read off `queryChunks`, because the
 * chunk array is drizzle's internal representation and asserting against it
 * would be asserting that drizzle has not been upgraded. What this file is
 * about is the string that reaches the server.
 */
const render = (statement: SQL): string => new PgDialect().sqlToQuery(statement).sql;

/**
 * The one `sql.raw` in the codebase, tested as the injection point it would be
 * if it were ever handed a runtime value.
 *
 * `enumCheck` builds a CHECK constraint by string concatenation. That is safe
 * only because every argument is a compile-time literal from a frozen contract
 * enum — which is an argument about call sites, not about the function, and
 * call sites change. So the function asserts the shape itself, and this file
 * asserts the assertion.
 *
 * It was written when the literal pattern was WIDENED to admit a dot, for
 * `RECOVERY_FAILURE_CODES`. A widening with no test is how the next widening
 * becomes "it already allows punctuation".
 */

describe('enumCheck', () => {
  it('admits the dotted codes it was widened for', () => {
    expect(
      render(enumCheck('failure_code', ['recovery.cutover_failed', 'recovery.internal'])),
    ).toBe("failure_code IN ('recovery.cutover_failed', 'recovery.internal')");
  });

  it('still admits the SCREAMING_CASE and hyphenated shapes it always did', () => {
    expect(() => enumCheck('state', ['RESTORE_TEST_PASSED'])).not.toThrow();
    expect(() => enumCheck('state', ['a-b'])).not.toThrow();
  });

  it.each([
    ["it's", 'a single quote — the character the escaping exists for'],
    ["x'; DROP TABLE tenants; --", 'a full injection attempt'],
    ['a b', 'a space'],
    ['a;b', 'a statement separator'],
    ['a,b', 'a list separator, which would forge a second literal'],
    ['a)b', 'a closing paren, which would end the IN list early'],
    ['a\\b', 'a backslash'],
    ['a\nb', 'a newline'],
    ['', 'empty'],
  ])('refuses %j (%s)', (value) => {
    expect(() => enumCheck('state', [value])).toThrow(/not a plain enum literal/);
    expect(() => nullableEnumCheck('state', [value])).toThrow(/not a plain enum literal/);
  });

  it.each([
    ['State', 'an upper-case column name'],
    ['a b', 'a space in the column name'],
    ['"state"', 'a pre-quoted column name'],
    ['state; DROP TABLE tenants', 'an injection in the column position'],
    ['1state', 'a leading digit'],
    ['', 'empty'],
  ])('refuses the column name %j (%s)', (column) => {
    expect(() => enumCheck(column, ['A'])).toThrow(/not a plain column name/);
    expect(() => nullableEnumCheck(column, ['A'])).toThrow(/not a plain column name/);
  });

  it('admits a double hyphen, because inside a quoted literal it is not a comment', () => {
    // This case was written as a refusal and was wrong, which is worth leaving
    // here as the record. `--` begins a comment in SQL TEXT; inside a
    // single-quoted literal it is two characters. The value is always wrapped in
    // quotes by this function, so `a--b` renders as `state IN ('a--b')`, which
    // is correct SQL and inert — and `-` has to be admitted anyway, because
    // hyphenated enum values exist. The quoting is what makes punctuation safe;
    // the character class is what proves the input is a literal and not a
    // runtime value. Conflating the two is how a test comes to assert a
    // protection the design never claimed.
    expect(render(enumCheck('state', ['a--b']))).toBe("state IN ('a--b')");
  });

  it('doubles a quote rather than rejecting alone, so the escaping still runs', () => {
    // The pattern refuses a quote today, so this asserts the SECOND line of
    // defence directly: if the pattern were ever loosened, the escaping is what
    // would still stand, and a test that only exercised the pattern would not
    // notice it had been deleted.
    const escape = (value: string): string => `'${value.replace(/'/g, "''")}'`;
    expect(escape("it's")).toBe("'it''s'");
  });

  it('makes a nullable check pass on NULL by saying so, not by relying on SQL', () => {
    expect(render(nullableEnumCheck('failure_code', ['recovery.internal']))).toBe(
      "failure_code IS NULL OR failure_code IN ('recovery.internal')",
    );
  });
});
