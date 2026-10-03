-- Program §6 — the terms and rules (`docs/terms-audit.md`): what `drizzle-kit` does not model
-- for 0167 — the guards that make a published version and an acceptance immutable, and the
-- backfill of the three new `terms.*` keys to the seeded roles that already exist.
-- Hand-written, so no snapshot accompanies it and the drift check has nothing to compare.
--
-- A PUBLISHED version is never changed or removed: an acceptance points at it, and "what
-- did this customer accept" must be answered by the text they were shown. A DRAFT is still
-- edited in place and may become PUBLISHED; that transition is the last UPDATE its row
-- ever takes. An acceptance is append-only outright.
--
-- WHY THE BACKFILL IS SAFE
--
-- All three keys are NEW in this release, so no installation can have withdrawn them, and
-- a DENY override still beats this because resolution subtracts DENY last. `owner` holds
-- every key; `operator` drafts (view + edit) and `support` reads; publishing (HIGH) stays
-- the owner's. `observer` holds every LOW key, so it takes `terms.view`.

CREATE OR REPLACE FUNCTION nexa_terms_version_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'PUBLISHED' THEN
    RAISE EXCEPTION
      'A published terms version is immutable; % is not permitted.', TG_OP
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id) THEN
    RAISE EXCEPTION
      'A terms version keeps its identity.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint

DROP TRIGGER IF EXISTS terms_versions_published_immutable ON terms_versions;--> statement-breakpoint
CREATE TRIGGER terms_versions_published_immutable
  BEFORE UPDATE OR DELETE ON terms_versions
  FOR EACH ROW EXECUTE FUNCTION nexa_terms_version_guard();--> statement-breakpoint

DROP TRIGGER IF EXISTS terms_acceptances_no_update ON terms_acceptances;--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_update
  BEFORE UPDATE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint
DROP TRIGGER IF EXISTS terms_acceptances_no_delete ON terms_acceptances;--> statement-breakpoint
CREATE TRIGGER terms_acceptances_no_delete
  BEFORE DELETE ON terms_acceptances
  FOR EACH ROW EXECUTE FUNCTION nexa_reject_mutation();--> statement-breakpoint

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'terms.view'),
        ('owner', 'terms.edit'),
        ('owner', 'terms.publish'),
        ('operator', 'terms.view'),
        ('operator', 'terms.edit'),
        ('support', 'terms.view'),
        ('observer', 'terms.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
