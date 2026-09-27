-- WP20 (brief §3.1): per-message retry scheduling for the outbox.
--
-- NULL means due now, so every row written before this migration is claimable exactly as
-- it was. A failure moves only its own row's next attempt; the messages behind it are
-- claimed meanwhile. Added nullable with no default: a metadata-only change, no rewrite of
-- a table that holds every event the installation ever wrote.
ALTER TABLE "outbox_messages" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint

-- The guard's list of immutable columns is unchanged: `next_attempt_at` is delivery
-- bookkeeping, like `attempts`, and was never in it. Only the refusal's sentence is
-- restated so it names every column that may change.
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
      'outbox_messages content is immutable; only published_at, attempts, last_error and next_attempt_at may change.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
