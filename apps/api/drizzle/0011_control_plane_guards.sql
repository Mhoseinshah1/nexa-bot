-- Guards, one index, and one backfill.
--
-- Split from 0010 because `drizzle-kit` generates 0010 from `schema.ts` and
-- would drop anything hand-written in it on the next regeneration. Triggers,
-- partial indexes and data changes live here, where the generator does not look.

-- Append-only -----------------------------------------------------------------
--
-- Both tables are evidence, and evidence that can be edited is not evidence.
-- `template_revisions` is the only record of what a message used to say — the
-- legacy Telegram surface has no reset, no default and no history at all, so an
-- overwritten text is simply gone (UNK-TXT-008). `notification_delivery_attempts`
-- is the only record of what happened on the wire.
--
-- These fire for every role including the owner. Production should ALSO run the
-- application as a role without UPDATE/DELETE on them; the triggers are the
-- floor, not the ceiling.

CREATE TRIGGER template_revisions_no_update
  BEFORE UPDATE ON template_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER template_revisions_no_delete
  BEFORE DELETE ON template_revisions
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER notification_delivery_attempts_no_update
  BEFORE UPDATE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

CREATE TRIGGER notification_delivery_attempts_no_delete
  BEFORE DELETE ON notification_delivery_attempts
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();
--> statement-breakpoint

-- The operational-event immutability guard ------------------------------------
--
-- 0001 froze everything but the dedupe counter, `last_seen_at`, `correlation_id`
-- and `context`; 0004 added `dedupe_scope` to the frozen set. Resolution now
-- needs two more columns to be writable, and ONLY those two.
--
-- Note what is still frozen: `code`, `severity`, `message`, `first_seen_at` and
-- both dedupe columns. A row cannot be re-labelled as a different condition, and
-- `occurrence_count` still cannot decrease. Marking a condition resolved is not
-- permission to rewrite what it was.

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
      'operational_events rows are immutable except for occurrence_count, last_seen_at, correlation_id, context and the resolution columns.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.occurrence_count < OLD.occurrence_count THEN
    RAISE EXCEPTION 'operational_events.occurrence_count may not decrease.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  -- A row may be marked resolved, and may be re-opened when the condition
  -- recurs. What it may not do is claim a resolver without a resolution time.
  IF NEW.resolved_at IS NULL AND NEW.resolved_by_event_id IS NOT NULL THEN
    RAISE EXCEPTION 'operational_events.resolved_by_event_id requires resolved_at.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

-- Backfill: templates.view and templates.edit for existing owners -------------
--
-- Seeded roles are written when a role is CREATED and never reasserted, so that
-- a restart cannot silently restore a permission an operator withdrew. The role
-- repository's own comment names the consequence and the remedy: a permission
-- newly added to a seed does not reach installations that already have the role,
-- and the fix is "a migration that says what it is doing". This is that
-- migration.
--
-- Only `owner`. That role holds the entire catalogue by construction, so adding
-- to it restores an invariant rather than making a judgement. Every other seeded
-- role may have been customised by whoever runs the installation, and quietly
-- widening one would be exactly the silent privilege restoration the
-- create-only rule exists to prevent — an operator who wants their operator role
-- to edit copy can grant it, with an audit row saying they did.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
CROSS JOIN (VALUES ('templates.view'), ('templates.edit')) AS p("key")
WHERE r."key" = 'owner'
ON CONFLICT DO NOTHING;
