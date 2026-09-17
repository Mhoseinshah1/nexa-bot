-- Backfill: the two permissions 5A adds to the seeded roles.
--
-- Hand-written, like 0011, 0031 and 0055, because `drizzle-kit` generates from
-- `schema.ts` and does not look at data. No snapshot accompanies it for the same reason:
-- it changes no schema, so the drift check has nothing to compare.
--
-- WHAT WOULD BREAK WITHOUT IT
--
-- `ensureSystemRoles` writes a seed's permissions when the role is CREATED and never
-- reasserts them — deliberately, because reasserting on every boot would silently restore
-- a permission an operator had withdrawn. The consequence is the one 0031 names: a
-- permission newly added to a seeded role does NOT reach an installation that already has
-- that role. Without this migration, the staging installation would render a Payment
-- Accounts screen on which every card answers access denied, while a fresh install of the
-- same image works. Same release, two behaviours, decided by install date.
--
-- WHY IT IS SAFE TO BACKFILL
--
-- 0011's argument, in its strongest form: `payments.accounts.view` and
-- `payments.accounts.edit` have never existed in any release, so no installation can have
-- had either WITHDRAWN from a role. There is no prior state to defer to.
--
-- `role_permissions` also has exactly one writer in the codebase, `ensureSystemRoles`,
-- and it only ever inserts. A withdrawal is a hand-written DELETE, and there is nothing
-- here to have deleted.
--
-- Nothing below deletes a permission, replaces a permission set, or touches `admin_roles`
-- or `admin_permission_overrides`. A DENY override still beats these grants, because
-- resolution subtracts DENY last.
--
-- WHO GETS WHICH, AND WHY
--
--   owner            both   — the owner role is seeded with the whole catalogue.
--   finance          both   — finance owns where money arrives. Without the edit key the
--                             only role able to replace a blocked card would be the
--                             owner, which is migration 0055's defect with a new name.
--   operator         view   — a NARROWING. Until this release an operator could change
--                             the card number, because it was typed into a template body
--                             and they hold `templates.edit`. The destination is data
--                             now; what is left is the question they need answered.
--   receipt_reviewer view   — reconciling a claimed transfer against a bank statement
--                             means knowing which account it should have arrived in.
--   observer         view   — the observer role is seeded with every LOW permission.
--
-- A role this migration does not find is not missed: `ensureSystemRoles` runs after
-- migrations at every boot and creates a missing seeded role with its full current
-- permission set.

-- The VALUES-join shape, matching 0011, 0031 and 0055, and not by taste: the
-- seed/backfill coverage guard reads the PAIRS out of this statement and a shape it does
-- not recognise yields nothing, which fails that test rather than quietly shrinking it.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'payments.accounts.view'),
        ('owner', 'payments.accounts.edit'),
        ('finance', 'payments.accounts.view'),
        ('finance', 'payments.accounts.edit'),
        ('operator', 'payments.accounts.view'),
        ('receipt_reviewer', 'payments.accounts.view'),
        ('observer', 'payments.accounts.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
