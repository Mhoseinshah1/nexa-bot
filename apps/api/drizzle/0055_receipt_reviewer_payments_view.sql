-- Backfill: the read the `receipt_reviewer` role needs to see what it is reviewing.
--
-- Hand-written, like 0011 and 0031, because `drizzle-kit` generates from `schema.ts`
-- and does not look at data. No snapshot accompanies it for the same reason: it changes
-- no schema, so the drift check has nothing to compare.
--
-- THE DEFECT THIS REPAIRS
--
-- `receipt_reviewer` was seeded with `receipts.view` and `receipts.review` and nothing
-- else. `PaymentService.get` charges `payments.view`, and the Web Admin route that
-- renders a payment sets its denied flag from the same key — so an operator holding
-- only that role opened the payment detail and got access denied, for every payment.
-- The approve form has been unreachable for them since 4C and the reject form 4G adds
-- would have shipped the same way.
--
-- `ensureSystemRoles` writes a seed's permissions when the role is CREATED and never
-- reasserts them, and says at length why: reasserting on every boot would silently
-- restore a permission an operator had deliberately withdrawn. The consequence it names
-- is this one — "a permission newly added to a seeded role does NOT reach installations
-- that already have that role" — and the remedy it names is a migration that says what
-- it is doing.
--
-- WHY THIS ONE IS SAFE TO BACKFILL
--
-- 0011 and 0031 make the argument and it holds here with one extra step. `payments.view`
-- is not a new key, so "a permission that did not exist cannot have been withdrawn" is
-- not available; what is available is narrower and stronger. This grant is scoped to
-- ONE role, `receipt_reviewer`, which no release has ever seeded with `payments.view` —
-- so no installation can have had it withdrawn from that role, because no installation
-- ever had it there to withdraw. Other roles are untouched.
--
-- `role_permissions` also has exactly one writer in the codebase, `ensureSystemRoles`,
-- and it only ever inserts; a withdrawal is a hand-written DELETE, and a hand-written
-- DELETE against a grant that was never made is not a state this could be deferring to.
--
-- Nothing here deletes a permission, replaces a permission set, touches `admin_roles`,
-- or touches `admin_permission_overrides`. A DENY override still beats this grant,
-- because resolution subtracts DENY last — so an operator who wants this role blind to
-- the payment list still has the mechanism for it.
--
-- A role this migration does not find is not missed: `ensureSystemRoles` runs after
-- migrations at every boot and creates a missing seeded role with its full current
-- permission set.

-- The VALUES-join shape, matching 0011 and 0031, and not by taste: the seed/backfill
-- coverage guard reads the PAIRS out of this statement and a shape it does not
-- recognise yields nothing, which fails that test rather than quietly shrinking it.
-- Written the other way first, and the guard caught it.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('receipt_reviewer', 'payments.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
