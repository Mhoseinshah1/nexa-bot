-- Program Item 15 (`docs/legacy-migration/trial-eligibility.md`): what `drizzle-kit` does
-- not model for 0183. Hand-written, so no snapshot accompanies it.
--
-- A legacy trial decision is made once and is the explanation of an override: rewriting
-- it would let the record disagree with what the migration actually did, and deleting it
-- would let a rerun decide again — re-imposing an override an operator has since lifted.
-- So the table is append-only, by the same function the other append-only tables use.
-- Tests reset with TRUNCATE, which bypasses row triggers.
--
-- Rollback: dropping the two triggers restores the release before this one exactly.

DROP TRIGGER IF EXISTS legacy_trial_eligibility_no_update ON legacy_trial_eligibility;--> statement-breakpoint
CREATE TRIGGER legacy_trial_eligibility_no_update
  BEFORE UPDATE ON legacy_trial_eligibility
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS legacy_trial_eligibility_no_delete ON legacy_trial_eligibility;--> statement-breakpoint
CREATE TRIGGER legacy_trial_eligibility_no_delete
  BEFORE DELETE ON legacy_trial_eligibility
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
