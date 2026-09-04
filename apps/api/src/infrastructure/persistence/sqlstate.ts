/**
 * Reading a PostgreSQL error code through whatever wrapped it.
 *
 * Extracted from the template repository, which needed it first. A second
 * caller copying it would have copied the `cause`-chain walk below too, and a
 * copy that stopped at the outer object is a check that quietly never matches —
 * the failure mode being that a conflict surfaces as an unhandled 500 rather
 * than as the domain error the caller went to the trouble of writing.
 */

/** Postgres `unique_violation`. */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if (findCode(error) !== '23505') return false;
  // A table can have several unique indexes and they mean different things.
  // Naming the one being handled keeps an unrelated violation an unhandled
  // error, which is what it is, rather than a plausible-looking wrong answer.
  return constraint === undefined || findConstraint(error) === constraint;
}

/**
 * The SQLSTATE, wherever the driver put it.
 *
 * `node-postgres` sets `code` on its own error; Drizzle wraps that in a
 * `DrizzleQueryError` and puts the original on `cause`. Reading only the outer
 * object would make this check quietly never match.
 */
function findCode(error: object, depth = 0): string | undefined {
  // Bounded. An error whose `cause` chain loops back on itself would otherwise
  // hang the request rather than report a conflict, and a driver is not
  // obliged to keep that chain acyclic.
  if (depth > 5) return undefined;
  const direct = (error as { code?: unknown }).code;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? findCode(cause, depth + 1) : undefined;
}

/** The violated constraint's name, down the same chain and with the same bound. */
function findConstraint(error: object, depth = 0): string | undefined {
  if (depth > 5) return undefined;
  const direct = (error as { constraint?: unknown }).constraint;
  if (typeof direct === 'string') return direct;
  const cause = (error as { cause?: unknown }).cause;
  return typeof cause === 'object' && cause !== null ? findConstraint(cause, depth + 1) : undefined;
}
