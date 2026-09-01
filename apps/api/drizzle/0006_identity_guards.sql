-- Identity guards.
--
-- Hand-written: these are trigger-enforced invariants, and drizzle-kit
-- generates DDL from a schema, not behaviour. Written forward rather than by
-- editing 0005, because an applied migration is never edited (ADR-0008).
--
-- Both guards are DEFENCE IN DEPTH. The application layer enforces the same
-- rules first, and does so with the row lock that actually makes them
-- concurrency-safe; a trigger that counts rows can still be raced by two
-- transactions that each see the other's row as present. The value here is that
-- a future code path which forgets the rule fails loudly instead of quietly
-- leaving an installation with no way in.

-- A system role is seeded from the frozen ROLE_SEEDS and must keep existing.
-- Deleting the owner role would leave an installation whose owner permissions
-- have no carrier — recoverable only by hand-editing the database.
CREATE OR REPLACE FUNCTION nexa_protect_system_role() RETURNS trigger AS $$
BEGIN
  IF OLD.is_system THEN
    RAISE EXCEPTION 'role % is a system role and cannot be deleted', OLD.key
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE TRIGGER roles_system_delete_guard
  BEFORE DELETE ON roles
  FOR EACH ROW EXECUTE FUNCTION nexa_protect_system_role();
--> statement-breakpoint

-- The last usable owner.
--
-- An installation must always retain at least one ACTIVE administrator holding
-- the owner role. Two paths can remove the last one — disabling the admin, and
-- unassigning the role — so both are guarded, and the check runs AFTER the row
-- change so it sees the state the transaction would actually commit.
CREATE OR REPLACE FUNCTION nexa_require_active_owner() RETURNS trigger AS $$
DECLARE
  target_tenant uuid;
  owner_count integer;
BEGIN
  target_tenant := COALESCE(NEW.tenant_id, OLD.tenant_id);

  SELECT count(*) INTO owner_count
  FROM admin_roles ar
  JOIN roles r ON r.id = ar.role_id
  JOIN admins a ON a.id = ar.admin_id
  WHERE ar.tenant_id = target_tenant
    AND r.key = 'owner'
    AND a.status = 'ACTIVE';

  IF owner_count = 0 THEN
    RAISE EXCEPTION 'tenant % would be left with no active owner', target_tenant
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER admin_roles_last_owner_guard
  AFTER DELETE ON admin_roles
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION nexa_require_active_owner();
--> statement-breakpoint

-- Deferred to the end of the transaction, so a legitimate hand-over — grant the
-- new owner, then disable the old one — passes, while a transaction that ends
-- with no active owner fails at COMMIT.
CREATE CONSTRAINT TRIGGER admins_last_owner_guard
  AFTER UPDATE OF status ON admins
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.status = 'DISABLED')
  EXECUTE FUNCTION nexa_require_active_owner();
