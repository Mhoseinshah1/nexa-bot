-- `payment_destinations` is append-only, in the database rather than in a code review.
--
-- Hand-written, like 0001, because `drizzle-kit` generates from `schema.ts` and does not
-- model triggers. No snapshot accompanies it for the same reason: it changes no schema,
-- so the drift check has nothing to compare.
--
-- WHY THIS TABLE, AND WHY A TRIGGER
--
-- The whole of 5A is one sentence: what a customer was told about where to send money
-- must not change afterwards. `payment_accounts` is configuration an operator edits at
-- will; this table is the frozen copy, and if a row here could be updated then editing an
-- account would once again rewrite instructions a customer transferred against yesterday
-- — the defect the split exists to remove, reintroduced one layer down.
--
-- An application rule would not be enough, and 0001 already says why in its own words:
-- these triggers fire for every role, including the table owner, so they hold against a
-- repair script, a migration and a future service method alike.
--
-- DELETE is refused too, and that is the less obvious half. A destination deleted while
-- its payment lives leaves a PENDING manual transfer whose instructions cannot be
-- re-rendered — and the surface would fall back to the pre-5A template, quietly telling
-- the customer to follow instructions that do not exist. An account is disabled, never
-- deleted (`payment_accounts` has no delete path at all), so nothing legitimate ever
-- needs to remove one of these.
--
-- Tests reset with TRUNCATE, which bypasses row triggers. That is deliberate and 0001
-- records it: the guard stays in force for application code.

CREATE TRIGGER payment_destinations_no_update
  BEFORE UPDATE ON payment_destinations
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER payment_destinations_no_delete
  BEFORE DELETE ON payment_destinations
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
