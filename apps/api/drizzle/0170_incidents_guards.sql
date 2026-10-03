-- Phase E3 (`docs/incidents.md`): what `drizzle-kit` does not model for 0169 — the
-- append-only guard on the incident timeline, and the backfill of the three new
-- `incidents.*` keys to the seeded roles that already exist. Hand-written, so no snapshot
-- accompanies it.
--
-- WHY THE BACKFILL IS SAFE: all three keys are NEW in this release, so no installation can
-- have withdrawn them, and a DENY override still beats this. `owner` holds every key;
-- `operator` runs incidents and tells customers; `technical` runs them; `support` reads
-- them. `incidents.view` is LOW, so `observer` (the read-only role) holds it too.

DROP TRIGGER IF EXISTS incident_events_no_update ON incident_events;--> statement-breakpoint
CREATE TRIGGER incident_events_no_update
  BEFORE UPDATE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS incident_events_no_delete ON incident_events;--> statement-breakpoint
CREATE TRIGGER incident_events_no_delete
  BEFORE DELETE ON incident_events
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'incidents.view'),
        ('owner', 'incidents.manage'),
        ('owner', 'incidents.notify'),
        ('operator', 'incidents.view'),
        ('operator', 'incidents.manage'),
        ('operator', 'incidents.notify'),
        ('technical', 'incidents.view'),
        ('technical', 'incidents.manage'),
        ('support', 'incidents.view'),
        ('observer', 'incidents.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
