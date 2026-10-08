-- Mirza migration PR6: what `drizzle-kit` does not model for 0232. Hand-written, so no
-- snapshot accompanies it.
--
-- A cutover approval is the owner's consent to import ONE frozen legacy snapshot, bound to
-- seven exact values. It is evidence of who consented to what and when, so it is never
-- edited — an approval whose values changed would be consent to something nobody approved —
-- and never deleted. It is withdrawn by a revocation row, which is itself never edited or
-- deleted, so a withdrawn approval can never quietly become valid again. The same guard the
-- audit log has (0001_append_only_guards.sql): the triggers fire for every role, the table
-- owner included.
--
-- Rollback: dropping the four triggers restores the release before this one exactly; no
-- row is rewritten.

CREATE TRIGGER legacy_cutover_approvals_no_update
  BEFORE UPDATE ON legacy_cutover_approvals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_cutover_approvals_no_delete
  BEFORE DELETE ON legacy_cutover_approvals
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_cutover_approval_revocations_no_update
  BEFORE UPDATE ON legacy_cutover_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_cutover_approval_revocations_no_delete
  BEFORE DELETE ON legacy_cutover_approval_revocations
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
