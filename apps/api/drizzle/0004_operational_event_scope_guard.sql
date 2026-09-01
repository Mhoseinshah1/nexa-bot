-- Extend the operational-event immutability guard to cover `dedupe_scope`.
--
-- 0003 made `dedupe_scope` part of the row's identity — it is half of the unique
-- key that decides which rows may collapse together. The guard installed in 0001
-- predates the column, so without this an UPDATE could move a row from one
-- tenant's dedupe namespace into another's, which is the very thing 0003 exists
-- to prevent.
--
-- `CREATE OR REPLACE FUNCTION` replaces the body in place; the triggers created
-- in 0001 keep pointing at it and do not need recreating.

CREATE OR REPLACE FUNCTION nexa_operational_events_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.message IS DISTINCT FROM OLD.message
     OR NEW.dedupe_scope IS DISTINCT FROM OLD.dedupe_scope
     OR NEW.dedupe_key IS DISTINCT FROM OLD.dedupe_key
     OR NEW.first_seen_at IS DISTINCT FROM OLD.first_seen_at
  THEN
    RAISE EXCEPTION
      'operational_events rows are immutable except for occurrence_count, last_seen_at, correlation_id and context.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.occurrence_count < OLD.occurrence_count THEN
    RAISE EXCEPTION 'operational_events.occurrence_count may not decrease.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
