-- v0.9.7 PR-1: the cleanup after a clean import («پاک‌سازی داده‌های انتقال»).
--
-- Hand-written: drizzle-kit does not model triggers, so no snapshot accompanies it.
--
-- `legacy_service_candidates` (0231) and `legacy_trial_eligibility` (0184) refuse every
-- DELETE. The owner decided both are dropped once an import has finished cleanly: nobody
-- reviews held services, and an imported customer MAY take a Nexa trial again. This guard
-- keeps refusing every delete, except one made inside a transaction that named, with
-- `set_config('nexa.legacy_compaction_run', <run id>, true)`, a compaction run of the row's
-- own tenant that is in CLEARING right now. A run reaches CLEARING only through the
-- executor, after its «آرشیو ربات قبلی» archive reached Telegram in every part (the 0266
-- rule for `legacy_history_records`). UPDATE guards are untouched.
--
-- Rollback: recreate the two no_delete triggers on `nexa_reject_mutation()` and drop this
-- function; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_legacy_cleanup_delete_guard() RETURNS trigger AS $$
DECLARE
  run_id text := current_setting('nexa.legacy_compaction_run', true);
BEGIN
  IF run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM legacy_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state = 'CLEARING') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS legacy_service_candidates_no_delete ON legacy_service_candidates;
--> statement-breakpoint

CREATE TRIGGER legacy_service_candidates_no_delete
  BEFORE DELETE ON legacy_service_candidates
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_cleanup_delete_guard();
--> statement-breakpoint

DROP TRIGGER IF EXISTS legacy_trial_eligibility_no_delete ON legacy_trial_eligibility;
--> statement-breakpoint

CREATE TRIGGER legacy_trial_eligibility_no_delete
  BEFORE DELETE ON legacy_trial_eligibility
  FOR EACH ROW EXECUTE FUNCTION nexa_legacy_cleanup_delete_guard();
