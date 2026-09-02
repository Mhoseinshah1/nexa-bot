-- Composite foreign keys: the database enforces tenant ownership.
--
-- Migration 0005 put `tenant_id` on every identity table and made every unique
-- index composite on it, so the APPLICATION could scope its predicates. But the
-- foreign keys still referenced globally unique ids alone:
--
--   admin_roles.admin_id -> admins(id)
--   admin_roles.role_id  -> roles(id)
--
-- which means a row could name tenant A while pointing at tenant B's admin and
-- tenant C's role, and the database would accept it. Every read afterwards
-- filters on `tenant_id`, so the mis-tenanted row is INVISIBLE to the tenant
-- that owns the id — it simply grants, or fails to grant, silently.
--
-- v1 deliberately has no RLS (ADR-0004). That decision costs nothing here: RLS
-- and referential integrity answer different questions, and "may these rows be
-- related at all" is the one a foreign key answers. Application predicates
-- remain mandatory; this is the layer that does not depend on remembering them.
--
-- Composite FKs need a matching composite candidate key on the referenced side,
-- so each parent gets a UNIQUE (tenant_id, id). That is redundant with the
-- primary key on `id` alone, and deliberately so: it is what lets a child say
-- "the admin with this id, IN THIS TENANT".

-- Parent candidate keys ------------------------------------------------------
ALTER TABLE "admins" ADD CONSTRAINT "admins_tenant_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_key" UNIQUE ("tenant_id", "id");
--> statement-breakpoint

-- admin_roles ----------------------------------------------------------------
ALTER TABLE "admin_roles" DROP CONSTRAINT "admin_roles_admin_id_admins_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_roles" DROP CONSTRAINT "admin_roles_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_tenant_admin_fk"
  FOREIGN KEY ("tenant_id", "admin_id") REFERENCES "public"."admins"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_tenant_role_fk"
  FOREIGN KEY ("tenant_id", "role_id") REFERENCES "public"."roles"("tenant_id", "id");
--> statement-breakpoint

-- role_permissions -----------------------------------------------------------
ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_role_id_roles_id_fk";
--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_tenant_role_fk"
  FOREIGN KEY ("tenant_id", "role_id") REFERENCES "public"."roles"("tenant_id", "id");
--> statement-breakpoint

-- admin_permission_overrides -------------------------------------------------
ALTER TABLE "admin_permission_overrides" DROP CONSTRAINT "admin_permission_overrides_admin_id_admins_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_permission_overrides" ADD CONSTRAINT "admin_permission_overrides_tenant_admin_fk"
  FOREIGN KEY ("tenant_id", "admin_id") REFERENCES "public"."admins"("tenant_id", "id");
--> statement-breakpoint

-- admin_sessions -------------------------------------------------------------
-- A session naming the wrong tenant is the worst case of the set: the session
-- lookup is the one read that is unscoped by necessity, and it RETURNS the
-- tenant every subsequent call is scoped to. A mis-tenanted row there would
-- hand a caller a scope that is not theirs.
ALTER TABLE "admin_sessions" DROP CONSTRAINT "admin_sessions_admin_id_admins_id_fk";
--> statement-breakpoint
ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_tenant_admin_fk"
  FOREIGN KEY ("tenant_id", "admin_id") REFERENCES "public"."admins"("tenant_id", "id");
--> statement-breakpoint

-- Actor references: assigned_by / created_by ---------------------------------
-- These name the administrator who performed a grant. They are NOT tenant-safe
-- by the same rule, so they get the same composite key against the row's own
-- tenant: only an administrator of this tenant can have granted a role in it.
--
-- Both stay NULLABLE, and that is not an oversight. Installation bootstrap
-- assigns the first owner role with no acting administrator, because none
-- exists yet — writing a fabricated actor there would be exactly the invented
-- identity this codebase refuses elsewhere. NULL means "the installation did
-- this", and the audit row with actor SYSTEM_JOB says so in full.
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_tenant_assigned_by_fk"
  FOREIGN KEY ("tenant_id", "assigned_by_admin_id") REFERENCES "public"."admins"("tenant_id", "id");
--> statement-breakpoint
ALTER TABLE "admin_permission_overrides" ADD CONSTRAINT "admin_permission_overrides_tenant_created_by_fk"
  FOREIGN KEY ("tenant_id", "created_by_admin_id") REFERENCES "public"."admins"("tenant_id", "id");
