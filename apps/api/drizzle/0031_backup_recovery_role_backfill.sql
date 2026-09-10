-- Backfill: the Backup and Recovery permissions the DR release added to seeds.
--
-- Hand-written, like 0011, because `drizzle-kit` generates from `schema.ts` and
-- does not look at data. No snapshot accompanies it for the same reason: it
-- changes no schema, so the drift check has nothing to compare.
--
-- THE DEFECT THIS REPAIRS
--
-- `ensureSystemRoles` writes a seed's permissions when the role is CREATED and
-- never reasserts them, and the repository says why at length: reasserting on
-- every boot would silently restore a permission an operator had deliberately
-- withdrawn, with no audit row and nothing to notice it. The consequence of
-- that choice is stated in the same comment — "a permission newly added to a
-- seeded role does NOT reach installations that already have that role" — and
-- the named remedy is "a migration that says what it is doing".
--
-- The DR release added four permissions to the catalogue and eight
-- (role, permission) pairs to `ROLE_SEEDS`, and shipped no such migration. So
-- on the staging installation, which has carried its roles since the identity
-- release, the Recovery section renders and every card in it answers access
-- denied: the owner role exists, and the authority the new surface checks for
-- was never written to it. A fresh installation of the same image is correct.
-- Same release, same screen, two behaviours decided by install date.
--
-- WHAT IS AND IS NOT SAFE TO BACKFILL
--
-- 0011 made this argument for `templates.*`: the create-only rule exists to
-- protect a permission somebody took away, and a permission that did not exist
-- until this release cannot have been taken away. The four keys here had one
-- release in which that was not strictly true — v0.1.0-staging.13 carries them,
-- so a role CREATED under it already holds them and could in principle have had
-- one removed since.
--
-- It could not have been removed through the product. `role_permissions` has
-- exactly one writer in the codebase, `ensureSystemRoles`, and it only ever
-- inserts; no surface, service or CLI deletes from it. A withdrawal is
-- therefore a hand-written DELETE against the database, and a hand-written
-- DELETE is not a state an upgrade owes deference to. Weighed against the
-- alternative — a temporal guard keyed on `roles.created_at` and drizzle's own
-- bookkeeping table, whose failure mode is this migration silently doing
-- nothing on the installation that reported the defect — the plain insert is
-- both the smaller change and the one whose failure is visible.
--
-- WHAT THIS TOUCHES
--
--   owner     — holds the whole catalogue by construction: all four
--   operator  — backup.view; whether the backups work is an operational question
--   technical — backup.view and backup.run; taking a backup before touching
--               anything is the safe move, and download and restore stay away
--   observer  — backup.view, because its seed is every LOW-risk permission
--
-- The pairs are exactly the eight `ROLE_SEEDS` gained in the DR release and no
-- others, which is what keeps this from widening anything beyond the frozen
-- contract. `backup.download` and `recovery.restore` reach ONLY `owner`.
--
-- Scoping, stated because each clause is load-bearing:
--
--   `r."tenant_id"` is read from the same row as `r."id"`, so an inserted row
--   cannot name one tenant's id beside another tenant's role. Every tenant the
--   installation holds is covered, not only the primary one.
--
--   `is_system = true` keeps a role an operator created out of it. A custom
--   role was never seeded from the catalogue, so nothing here is theirs to
--   widen — and the key alone is not enough, because a custom role may share a
--   key with a seeded one in another tenant.
--
--   `ON CONFLICT DO NOTHING` makes a re-run a no-op rather than an error, and
--   makes a role that already holds a grant keep exactly what it has.
--
-- Nothing here deletes a permission, replaces a permission set, touches
-- `admin_roles`, or touches `admin_permission_overrides`. A DENY override still
-- beats the grant this adds, because resolution subtracts DENY last.
--
-- A role this migration does not find is not missed: `ensureSystemRoles` runs
-- after migrations at every boot and creates a missing seeded role with its
-- full current permission set.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner',     'backup.view'),
        ('owner',     'backup.run'),
        ('owner',     'backup.download'),
        ('owner',     'recovery.restore'),
        ('operator',  'backup.view'),
        ('technical', 'backup.view'),
        ('technical', 'backup.run'),
        ('observer',  'backup.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
