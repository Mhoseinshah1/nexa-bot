-- Mirza migration PR3: an archived legacy invoice revision is history, so it is never
-- rewritten or removed. The same guard the audit log has (0001_append_only_guards.sql):
-- the triggers fire for every role, the table owner included. A changed legacy row is a NEW
-- revision row; an unchanged one writes nothing; an invoice a later snapshot no longer has
-- stays archived (counted as missing, never deleted).
--
-- An ingest run is the provenance every revision names, so it is never deleted either. Its
-- state still moves (STAGING -> VERIFIED -> COMPLETED | FAILED), by conditional UPDATEs
-- naming their from-state, so only DELETE is refused there. The staging rows are scratch and
-- carry no guard: they are deleted when their run completes or fails.

CREATE TRIGGER legacy_invoice_archive_no_update
  BEFORE UPDATE ON legacy_invoice_archive
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_invoice_archive_no_delete
  BEFORE DELETE ON legacy_invoice_archive
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER legacy_invoice_archive_runs_no_delete
  BEFORE DELETE ON legacy_invoice_archive_runs
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
