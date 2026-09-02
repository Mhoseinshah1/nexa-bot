-- The released-claim ledger is append-only.
--
-- Split from 0012 for the reason 0011 gives: `drizzle-kit` generates the table
-- migration from `schema.ts` and would drop anything hand-written in it on the
-- next regeneration. Triggers live here, where the generator does not look.
--
-- `notification_released_claims` became load-bearing the moment spend was
-- derived from it. `spentAttempts` is `attempt_count` minus these rows, and
-- `claimDue`, `failExhausted` and the dispatcher's abandonment test all read
-- that figure — so a row deleted here silently spends an attempt that was
-- handed back, and a row inserted or edited here silently returns one that was
-- not. Either would let a message be sent past its ceiling, or be written off
-- having never been sent, with nothing in the history to explain it.
--
-- It is also evidence in its own right: alongside the attempt rows it is what
-- says whether a claim reached the transport, which is the question the whole
-- ownership model exists to answer.
--
-- Insert-only is exactly the access the code needs. `releaseClaim` inserts with
-- ON CONFLICT DO NOTHING and nothing anywhere updates or deletes a released
-- claim; the idempotency of a hand-back rests on that conflict being a no-op
-- rather than on any later correction.
--
-- These fire for every role including the owner. Production should ALSO run the
-- application as a role without UPDATE/DELETE on them; the triggers are the
-- floor, not the ceiling.

CREATE TRIGGER notification_released_claims_no_update
  BEFORE UPDATE ON notification_released_claims
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER notification_released_claims_no_delete
  BEFORE DELETE ON notification_released_claims
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
