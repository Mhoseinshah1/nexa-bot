-- Backfill: the `orders.fulfil` permission this release adds to Finance.
--
-- Hand-written, like 0011 and 0031, because `drizzle-kit` generates from
-- `schema.ts` and does not look at data. No snapshot accompanies it for the
-- same reason: it changes no schema, so the drift check has nothing to compare.
--
-- WHY IT IS NEEDED
--
-- `ensureSystemRoles` writes a seed's permissions when the role is CREATED and
-- never reasserts them — reasserting on every boot would silently restore a
-- permission an operator had deliberately withdrawn. The consequence, stated in
-- that repository and repaired by 0031 once already: a permission newly added
-- to a seeded role does NOT reach installations that already have that role.
--
-- Without this, an installation that has carried its roles since an earlier
-- release would render the retry control on a stranded order and answer every
-- press with access denied — while a fresh install of the same image works.
-- Same release, two behaviours decided by install date.
--
-- WHY IT IS SAFE
--
-- `orders.fulfil` did not exist before this release, so it cannot be a
-- permission somebody took away — which is the entire reason the create-only
-- rule exists. 0011 made this argument first and 0031 restated it.
--
-- Nothing here deletes a permission, replaces a permission set, touches
-- `admin_roles` or touches `admin_permission_overrides`. A DENY override still
-- beats the grant this adds, because resolution subtracts DENY last. Owner
-- holds every permission by construction (`ALL`) and needs no row here beyond
-- the one this inserts.
--
-- A role this migration does not find is not missed: `ensureSystemRoles` runs
-- after migrations at every boot and creates a missing seeded role with its
-- full current permission set.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner',   'orders.fulfil'),
        ('finance', 'orders.fulfil')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
