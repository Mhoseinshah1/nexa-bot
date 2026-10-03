-- Customer notes and tags (program §8, `docs/customer-notes-tags.md`): what `drizzle-kit`
-- does not model for 0165 — the append-only guard on `customer_notes`, and the backfill of
-- the four new `users.*` keys to the seeded roles that already exist. Hand-written, so no
-- snapshot accompanies it and the drift check has nothing to compare.
--
-- WHY NOTES ARE APPEND-ONLY
--
-- A note is what one operator records about a customer for the next one. A correction is a
-- second note; nothing rewrites or removes the first, so what a customer was said to have
-- done cannot be quietly changed afterwards. There is no edit and no delete path in the
-- application either.
--
-- WHY THE BACKFILL IS SAFE
--
-- All four keys are NEW in this release, so no installation can have withdrawn them, and a
-- DENY override still beats this because resolution subtracts DENY last. `owner` holds every
-- key; `operator` takes all four — the notes and tags it keeps on the customers it supports.
-- None is LOW (`users.notes.view` is MEDIUM on purpose), so `observer` gains nothing.

DROP TRIGGER IF EXISTS customer_notes_no_update ON customer_notes;--> statement-breakpoint
CREATE TRIGGER customer_notes_no_update
  BEFORE UPDATE ON customer_notes
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS customer_notes_no_delete ON customer_notes;--> statement-breakpoint
CREATE TRIGGER customer_notes_no_delete
  BEFORE DELETE ON customer_notes
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'users.notes.view'),
        ('owner', 'users.notes.write'),
        ('owner', 'users.tags.assign'),
        ('owner', 'users.tags.manage'),
        ('operator', 'users.notes.view'),
        ('operator', 'users.notes.write'),
        ('operator', 'users.tags.assign'),
        ('operator', 'users.tags.manage')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
