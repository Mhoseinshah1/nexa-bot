-- Mirza `.nxpkg` importer: what `drizzle-kit` does not model for 0241. Hand-written, so no
-- snapshot accompanies it.
--
-- An archived Mirza history record is history: it is never rewritten or removed. A resumed
-- ingest continues by idempotency key and writes nothing twice, so nothing needs to UPDATE
-- a row. The same guard the audit log has (0001_append_only_guards.sql): the triggers fire
-- for every role, the table owner included.
--
-- A package import is the provenance every history record names, so it is never deleted
-- either. Its state still moves (conditional UPDATEs naming their from-states, the key is
-- erased at a terminal state), so only DELETE is refused there.
--
-- Rollback: dropping the three triggers restores the release before this one exactly; no
-- row is rewritten.

CREATE TRIGGER legacy_history_records_no_update
  BEFORE UPDATE ON legacy_history_records
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_history_records_no_delete
  BEFORE DELETE ON legacy_history_records
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_nxpkg_imports_no_delete
  BEFORE DELETE ON legacy_nxpkg_imports
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
