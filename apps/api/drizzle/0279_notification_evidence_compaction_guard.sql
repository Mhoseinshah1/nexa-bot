-- Round 9 C3 (data compaction): the ONE exception to the operator lane's evidence being
-- undeletable.
--
-- Hand-written: drizzle-kit does not model triggers, so no snapshot accompanies it. The
-- pattern is 0266's for `legacy_history_records`.
--
-- 0011 and 0013 made `notification_delivery_attempts` and `notification_released_claims`
-- append-only for every role. They stay so for UPDATE, always, and for DELETE everywhere but
-- one place: the data compaction removes a FINISHED notification (SENT or FAILED, past its
-- retention) together with its attempts and its released claims, as one unit, so the
-- dispatcher's invariant "a terminal intent always has at least one attempt row behind it"
-- holds for every intent that still exists. A DELETE is accepted only inside a transaction
-- that named, with `set_config('nexa.data_compaction_run', <run id>, true)`, an APPLY pass of
-- the row's own tenant that is RUNNING right now, AND only for a row whose notification is
-- not PENDING. A setting naming any other pass, a dry run, or no pass, is refused exactly as
-- before; so is any row of an intent still in flight, whatever the setting says.
--
-- Rollback: recreate the two `_no_delete` triggers on `nexa_reject_mutation()` and drop this
-- function; no row is rewritten.

CREATE OR REPLACE FUNCTION nexa_notification_evidence_guard() RETURNS trigger AS $$
DECLARE
  run_id text := current_setting('nexa.data_compaction_run', true);
BEGIN
  IF TG_OP = 'DELETE' AND run_id IS NOT NULL AND run_id <> '' AND EXISTS (
       SELECT 1 FROM data_compaction_runs AS run
        WHERE run.id = run_id::uuid
          AND run.tenant_id = OLD.tenant_id
          AND run.state = 'RUNNING'
          AND run.mode = 'APPLY')
     AND EXISTS (
       SELECT 1 FROM notifications AS n
        WHERE n.tenant_id = OLD.tenant_id
          AND n.id = OLD.notification_id
          AND n.status <> 'PENDING') THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER notification_delivery_attempts_no_delete ON notification_delivery_attempts;
--> statement-breakpoint

DROP TRIGGER notification_released_claims_no_delete ON notification_released_claims;
--> statement-breakpoint

CREATE TRIGGER notification_delivery_attempts_no_delete
  BEFORE DELETE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION nexa_notification_evidence_guard();
--> statement-breakpoint

CREATE TRIGGER notification_released_claims_no_delete
  BEFORE DELETE ON notification_released_claims
  FOR EACH ROW EXECUTE FUNCTION nexa_notification_evidence_guard();
