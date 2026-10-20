-- Round 4 PR-E (E1): the ONE exception to `legacy_history_records` being append-only.
--
-- Hand-written: drizzle-kit does not model triggers, so no snapshot accompanies it.
--
-- 0242 made the archive append-only for every role. The owner's compaction of the imported
-- legacy data («فشرده‌سازی داده‌های ربات قبلی») must delete the record types nothing reads
-- and strip constant flags from the rest, after a verified, fully delivered archive backup.
-- This guard keeps refusing EVERY update and delete, except one made inside a transaction
-- that named, with `set_config('nexa.legacy_compaction_run', <run id>, true)`, a
-- compaction run of the row's own tenant that is in a destructive stage RIGHT NOW. The run
-- reaches those stages only through the executor, and only after the archive's every part
-- has a Telegram message id; a setting naming any other run, or no run, is refused exactly
-- as before. An UPDATE may change the payload and nothing else.
--
-- Rollback: recreate the two 0242 triggers on `nexa_reject_mutation()` and drop this
-- function; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_history_guard() RETURNS trigger AS $$
DECLARE
  run_id text := current_setting('nexa.legacy_compaction_run', true);
BEGIN
  IF run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM legacy_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state IN ('DROPPING', 'DEDUPING', 'STRIPPING')) THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.nxpkg_import_id IS DISTINCT FROM OLD.nxpkg_import_id
       OR NEW.package_import_id IS DISTINCT FROM OLD.package_import_id
       OR NEW.record_type IS DISTINCT FROM OLD.record_type
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.legacy_user_id IS DISTINCT FROM OLD.legacy_user_id
       OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
       OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'A legacy compaction may change a history record''s payload only.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER legacy_history_records_no_update ON legacy_history_records;
--> statement-breakpoint

DROP TRIGGER legacy_history_records_no_delete ON legacy_history_records;
--> statement-breakpoint

CREATE TRIGGER legacy_history_records_no_update
  BEFORE UPDATE ON legacy_history_records
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_history_guard();
--> statement-breakpoint

CREATE TRIGGER legacy_history_records_no_delete
  BEFORE DELETE ON legacy_history_records
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_history_guard();
