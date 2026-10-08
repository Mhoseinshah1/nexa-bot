-- Mirza migration PR1: a recorded read set observation is evidence, so it is never
-- rewritten or removed. The same guard the audit log has (0001_append_only_guards.sql):
-- the triggers fire for every role, the table owner included. A second observation of the
-- same thing is refused by the observation key and records nothing new; a different
-- observation is a new row.

CREATE TRIGGER legacy_read_set_runs_no_update
  BEFORE UPDATE ON legacy_read_set_runs
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_read_set_runs_no_delete
  BEFORE DELETE ON legacy_read_set_runs
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
