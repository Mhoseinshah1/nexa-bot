-- Phase 6B PR-5 («ورود به پنل», ADR-0039 § 9 refinement 1): the HOST principal is not the
-- hosted tenant's to change.
--
-- Hand-written: drizzle-kit does not model triggers, so no snapshot accompanies it.
--
-- Each hosted tenant has at most one admin of kind HOST (`admins_tenant_host_key`): the
-- installation owner's principal there, with no password and no role, created on his first
-- enter. The tenant's own administrators must not be able to edit, disable, rename, bind or
-- delete it, nor turn an operator into a HOST or the HOST into an operator — whatever path the
-- application takes. The service refuses such a target too (as not found); this is the
-- guarantee that a future write path cannot forget. INSERT stays open: the unique index keeps
-- it to one, the sign-in cannot reach it (no password), and a tenant restore must be able to
-- carry the row its history references.
--
-- Rollback: DROP TRIGGER admins_host_guard ON admins; DROP FUNCTION nexa_host_admin_guard();

CREATE OR REPLACE FUNCTION nexa_host_admin_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.kind = 'HOST' THEN
      RAISE EXCEPTION 'The host principal of a hosted tenant cannot be deleted.'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD.kind = 'HOST' OR NEW.kind IS DISTINCT FROM OLD.kind THEN
    RAISE EXCEPTION 'The host principal of a hosted tenant cannot be changed.'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS admins_host_guard ON admins;
--> statement-breakpoint
CREATE TRIGGER admins_host_guard
  BEFORE UPDATE OR DELETE ON admins
  FOR EACH ROW EXECUTE FUNCTION nexa_host_admin_guard();
