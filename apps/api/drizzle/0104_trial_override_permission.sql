-- Backfill: `users.trial.edit` reaches the roles that already exist.
--
-- Hand-written, like 0031, 0055, 0064 and 0071, because `drizzle-kit` generates from
-- `schema.ts` and does not look at data. It changes no schema, so no snapshot
-- accompanies it and the drift check has nothing to compare.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and
-- never reasserts them, so that a permission an operator withdrew stays withdrawn. The
-- consequence is that a key newly added to a seeded role does not reach an installation
-- whose role already exists. This migration is the remedy that function names.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- `users.trial.edit` is NEW in this release (WP6-B, `docs/wp6-audit.md` B2). No
-- installation can have withdrawn it from any role, because none has ever had it. This
-- migration deletes nothing and replaces nothing. It does not touch `admin_roles` or
-- `admin_permission_overrides`, and a DENY override still beats this grant, because
-- resolution subtracts DENY last.
--
-- `settings.destructive`, which the global reset charges, needs no line here. It was
-- seeded to `owner` at the identity release and has been in every owner role since.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill
-- coverage guard reads the PAIRS out of this statement.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'users.trial.edit'),
        ('operator', 'users.trial.edit')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
