-- Row-level security, part 1: the roles, the grants and the policy functions (ADR-0037).
--
-- ADR-0004 scoped tenants in the repository layer only, because one install served one
-- customer. One install now hosts many unrelated owners' bots, so a missed tenant
-- predicate is a leak between strangers, and PostgreSQL enforces the boundary itself.
--
-- THREE ROLES. The table owner (the role this migration runs as, `nexa` on a Docker
-- install) is the migrator: it owns every table, runs migrations, dumps and restores.
-- `nexa_app` is what the API, worker, monitor, provisioner, assistant and recovery
-- processes connect as: no BYPASSRLS, no ownership. `nexa_system` never logs in; the
-- application reaches it only by `SET ROLE` for an explicit `SystemContext`, and its
-- policy refuses every row unless that context's reason is bound (`app.system_reason`).
--
-- THE POLICIES ARE NOT HERE. `ENABLE ROW LEVEL SECURITY` and `CREATE POLICY` take an
-- ACCESS EXCLUSIVE lock, and drizzle runs every pending migration in ONE transaction
-- while the outgoing release is still serving: two hundred tables locked until commit.
-- `row-level-security.ts` applies them after the migrator, one table per short
-- transaction under a lock_timeout, for every table with a `tenant_id` column — so a
-- table added by a later migration is covered by the same run that creates it.
--
-- ROLLOUT. This changes nothing for an install that still connects as the owner: the
-- owner bypasses RLS (nothing here FORCEs it) and a superuser bypasses it always. It
-- takes effect when the processes connect as `nexa_app` (`DATABASE_APP_URL`, written by
-- `botctl update`/the installer with a generated password).
--
-- Creating a role needs CREATEROLE. A Docker install's owner is the image's superuser; a
-- development cluster gets the roles from `scripts/dev-services.sh`. Idempotent: an
-- existing role is checked, never recreated, and refused if it could bypass the policies.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexa_app') THEN
    BEGIN
      CREATE ROLE nexa_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'nexa: role nexa_app does not exist and % may not create it', current_user
        USING HINT = 'Run the migration as a role with CREATEROLE once (a Docker install''s owner is), or create nexa_app and nexa_system first (scripts/dev-services.sh does for development). ADR-0037.';
    END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexa_system') THEN
    BEGIN
      CREATE ROLE nexa_system NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE EXCEPTION 'nexa: role nexa_system does not exist and % may not create it', current_user
        USING HINT = 'Run the migration as a role with CREATEROLE once, or create the roles first (scripts/dev-services.sh). ADR-0037.';
    END;
  END IF;
  -- A role that can bypass the policies makes them decorative. Refused, never repaired
  -- silently: somebody granted it, and an operator should know.
  IF EXISTS (
    SELECT 1 FROM pg_roles
     WHERE rolname IN ('nexa_app', 'nexa_system') AND (rolsuper OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'nexa: nexa_app or nexa_system is SUPERUSER or BYPASSRLS, which defeats row-level security'
      USING HINT = 'ALTER ROLE nexa_app NOSUPERUSER NOBYPASSRLS; ALTER ROLE nexa_system NOSUPERUSER NOBYPASSRLS; ADR-0037.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nexa_system' AND rolcanlogin) THEN
    RAISE EXCEPTION 'nexa: nexa_system can log in; it must be reachable only by SET ROLE from nexa_app'
      USING HINT = 'ALTER ROLE nexa_system NOLOGIN; ADR-0037.';
  END IF;
  -- nexa_app may SET ROLE nexa_system, and does not inherit its privileges: being a
  -- member grants nothing until the switch is made, explicitly, for one checkout.
  IF NOT EXISTS (
    SELECT 1
      FROM pg_auth_members m
      JOIN pg_roles granted ON granted.oid = m.roleid
      JOIN pg_roles member ON member.oid = m.member
     WHERE granted.rolname = 'nexa_system' AND member.rolname = 'nexa_app'
  ) THEN
    GRANT nexa_system TO nexa_app WITH INHERIT FALSE, SET TRUE;
  END IF;
END
$$;
--> statement-breakpoint

GRANT USAGE ON SCHEMA public TO nexa_app, nexa_system;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nexa_app, nexa_system;
--> statement-breakpoint
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO nexa_app, nexa_system;
--> statement-breakpoint
-- Tables a later migration creates (as this same owner) get the same grants.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nexa_app, nexa_system;
--> statement-breakpoint
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO nexa_app, nexa_system;
--> statement-breakpoint
-- Readiness compares the applied ledger with the release's journal; read-only. Guarded:
-- the drizzle migrator creates that schema, a hand-applied history does not.
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    GRANT USAGE ON SCHEMA drizzle TO nexa_app, nexa_system;
    GRANT SELECT ON drizzle.__drizzle_migrations TO nexa_app, nexa_system;
  END IF;
END
$$;
--> statement-breakpoint

-- THE POLICY FUNCTIONS. The policy (`row-level-security.ts`) is ONE per table, TO PUBLIC:
--
--   USING ((SELECT nexa_rls_system_path()) OR tenant_id = (SELECT nexa_current_tenant_id()))
--
-- TO PUBLIC, with the role named INSIDE these functions rather than in `TO nexa_app`,
-- because a policy that names a role cannot be restored where the role does not exist:
-- the backup's verification restores on a scratch server with no Nexa roles, and a
-- recovery may restore into a fresh cluster. And PUBLIC is the right audience: any role
-- that is not the owner — nexa_app, or one somebody adds later — must have a tenant bound.
-- Each is called through `(SELECT ...)`, so it is evaluated once per statement (an init
-- plan), not once per row.

-- The system path: true only as nexa_system, and only with its reason bound. RAISES as
-- nexa_system without a reason — the reason is the audit trail, there is no default.
CREATE OR REPLACE FUNCTION nexa_rls_system_path() RETURNS boolean
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
BEGIN
  IF current_user <> 'nexa_system' THEN
    RETURN false;
  END IF;
  IF coalesce(current_setting('app.system_reason', true), '') = '' THEN
    RAISE EXCEPTION 'nexa: the system role was used without a reason (app.system_reason is unset)'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'System work runs under an explicit SystemContext carrying its reason. ADR-0037.';
  END IF;
  RETURN true;
END
$$;
--> statement-breakpoint

-- The tenant a statement runs for. RAISES when none is bound rather than returning NULL:
-- an unbound read that came back empty would look like "not found" and could drive a
-- wrong decision; an error names the bug. NULL on the system path, which the policy has
-- already admitted.
CREATE OR REPLACE FUNCTION nexa_current_tenant_id() RETURNS uuid
  LANGUAGE plpgsql STABLE PARALLEL SAFE AS $$
DECLARE
  bound text;
BEGIN
  IF current_user = 'nexa_system' THEN
    RETURN NULL;
  END IF;
  bound := current_setting('app.current_tenant_id', true);
  IF bound IS NULL OR bound = '' THEN
    RAISE EXCEPTION 'nexa: no tenant is bound to this statement (app.current_tenant_id is unset)'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Tenant-scoped work runs through the unit of work or a scope-bound adapter; system work through a SystemContext. ADR-0037.';
  END IF;
  RETURN bound::uuid;
END
$$;
--> statement-breakpoint

-- THE INSTALLATION-WIDE GATES. The write gate asks, inside EVERY unit of work's
-- transaction, whether a recovery or a Mirza import has frozen the installation. Those
-- rows belong to the installation's tenant, and under row-level security a hosted
-- tenant's transaction would not see them — its writes would sail through a restore.
-- These two functions answer exactly that question and nothing wider, as the owner
-- (SECURITY DEFINER: the owner bypasses RLS), on the caller's own transaction so the
-- gate keeps its in-transaction guarantee. The states come from the caller, which holds
-- the one list of them; the answer is an id and a state, never a row.
CREATE OR REPLACE FUNCTION nexa_installation_recovery(states text[])
  RETURNS TABLE (id uuid, state text)
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT r.id, r.state FROM recovery_requests r WHERE r.state = ANY (states) LIMIT 1
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION nexa_installation_nxpkg_import(statuses text[])
  RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT i.id FROM legacy_nxpkg_imports i WHERE i.status = ANY (statuses)
   ORDER BY i.created_at LIMIT 1
$$;
--> statement-breakpoint
-- The same shape for the one deliberately cross-tenant question the payment path asks
-- inside a tenant's transaction: is this provider order id already used by ANY tenant
-- (tenants sharing one merchant account share its order namespace;
-- `docs/centralpay-gateway-audit.md` § 3). Existence only, as before.
CREATE OR REPLACE FUNCTION nexa_gateway_order_id_taken(provider text, provider_order_id text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM gateway_invoices g
     WHERE g.provider = nexa_gateway_order_id_taken.provider
       AND g.provider_order_id = nexa_gateway_order_id_taken.provider_order_id
  )
$$;
--> statement-breakpoint
-- And the adoption of a Mirza service: is this name held on the PANEL by any tenant's live
-- service (`services_panel_provider_username_key` is per panel), or reserved in the
-- panel's NAMESPACE by anyone (the host's, not the tenant's)? Existence only.
CREATE OR REPLACE FUNCTION nexa_service_username_taken(panel uuid, namespace_key text, canonical text)
  RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
           SELECT 1 FROM services s
            WHERE s.panel_id = nexa_service_username_taken.panel
              AND s.state <> 'TERMINATED'
              AND lower(s.provider_username) = nexa_service_username_taken.canonical)
      OR EXISTS (
           SELECT 1 FROM service_username_reservations r
            WHERE r.namespace_key = nexa_service_username_taken.namespace_key
              AND r.username = nexa_service_username_taken.canonical)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION nexa_service_username_taken(uuid, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nexa_service_username_taken(uuid, text, text) TO nexa_app, nexa_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION nexa_gateway_order_id_taken(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nexa_gateway_order_id_taken(text, text) TO nexa_app, nexa_system;
--> statement-breakpoint
REVOKE ALL ON FUNCTION nexa_installation_recovery(text[]) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION nexa_installation_nxpkg_import(text[]) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nexa_installation_recovery(text[]) TO nexa_app, nexa_system;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION nexa_installation_nxpkg_import(text[]) TO nexa_app, nexa_system;
