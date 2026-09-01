-- Append-only enforcement, in the database rather than in a code review.
--
-- The legacy system's `/admin/logs` is an activity feed, not an audit trail:
-- a free-text Persian sentence, one customer id, no before/after values, and
-- nothing preventing a row from being edited or removed. An audit log that can
-- be rewritten is not evidence.
--
-- These triggers fire for every role, including the table owner, so they hold
-- even in a single-role development database. Production should ALSO run the
-- application as a non-owner role without UPDATE/DELETE grants on these tables;
-- the triggers are the floor, not the ceiling.

CREATE OR REPLACE FUNCTION nexa_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only; % is not permitted.', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_update
  BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER audit_logs_no_delete
  BEFORE DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER processed_messages_no_update
  BEFORE UPDATE ON processed_messages
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER processed_messages_no_delete
  BEFORE DELETE ON processed_messages
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

-- `operational_events` is not strictly append-only: a repeated condition
-- collapses onto one row and increments its counter, which is the whole point
-- of the dedupe key. Everything else about the row is frozen, and no row may be
-- deleted — the legacy log group recorded 60 identical TLS errors in one day
-- with no way either to suppress them or to mark them resolved.
CREATE OR REPLACE FUNCTION nexa_operational_events_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.code IS DISTINCT FROM OLD.code
     OR NEW.severity IS DISTINCT FROM OLD.severity
     OR NEW.message IS DISTINCT FROM OLD.message
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
--> statement-breakpoint

CREATE TRIGGER operational_events_immutable_fields
  BEFORE UPDATE ON operational_events
  FOR EACH ROW EXECUTE FUNCTION nexa_operational_events_guard();
--> statement-breakpoint

CREATE TRIGGER operational_events_no_delete
  BEFORE DELETE ON operational_events
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

-- An outbox row's content is fixed once written; only delivery bookkeeping
-- changes. A relay that could rewrite an event payload would defeat the point
-- of writing it in the business transaction.
CREATE OR REPLACE FUNCTION nexa_outbox_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.aggregate_type IS DISTINCT FROM OLD.aggregate_type
     OR NEW.aggregate_id IS DISTINCT FROM OLD.aggregate_id
     OR NEW.sequence IS DISTINCT FROM OLD.sequence
     OR NEW.event_type IS DISTINCT FROM OLD.event_type
     OR NEW.event_version IS DISTINCT FROM OLD.event_version
     OR NEW.payload::text IS DISTINCT FROM OLD.payload::text
     OR NEW.actor::text IS DISTINCT FROM OLD.actor::text
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
  THEN
    RAISE EXCEPTION
      'outbox_messages content is immutable; only published_at, attempts and last_error may change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER outbox_messages_immutable_content
  BEFORE UPDATE ON outbox_messages
  FOR EACH ROW EXECUTE FUNCTION nexa_outbox_guard();
