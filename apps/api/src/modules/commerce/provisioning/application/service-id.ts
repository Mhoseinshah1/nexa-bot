import { COMMERCE_ERROR_CODES, errors, uuidV7Schema } from '@nexa/contracts';

/**
 * A service id from outside, or `SERVICE_NOT_FOUND`.
 *
 * `services.id` is a `uuid` column, so without this a malformed id reaches PostgreSQL
 * as an invalid cast and returns a 500 — an internal error for what is an ordinary bad
 * request, and a different answer from the one a valid-but-unknown id gets.
 *
 * The answer is the same one a well-formed id that does not exist gets, deliberately:
 * a surface must not be able to distinguish "no such service" from "not your tenant"
 * from "not a uuid", because the first two are the tenancy answer and telling them
 * apart is how an id becomes a probe.
 *
 * ONE copy, shared by every entry point that takes an id as a string — the read path,
 * the operator actions, the customer actions and the resend. `ServiceAdminService` had
 * a private version of this and the write paths added in Phase 6A did not, which is
 * exactly the shape a second copy takes: the read was correct and the new write was a
 * 500, on the same id, on the same screen.
 */
export function serviceIdOrNotFound(raw: string): string {
  const parsed = uuidV7Schema.safeParse(raw);
  if (!parsed.success) {
    throw errors.notFound(COMMERCE_ERROR_CODES.SERVICE_NOT_FOUND, 'Unknown service.');
  }
  return parsed.data;
}
