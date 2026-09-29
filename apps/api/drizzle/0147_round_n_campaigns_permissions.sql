-- Backfill: `campaigns.view` and `campaigns.manage` reach the roles that already exist.
--
-- Hand-written, like 0109, because `drizzle-kit` generates from `schema.ts` and does not
-- look at data. It changes no schema, so no snapshot accompanies it and the drift check has
-- nothing to compare.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and never
-- reasserts them, so a key newly added to a seeded role does not reach an installation whose
-- role already exists; this migration is the remedy that function names.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- Both keys are NEW in this release (round N, C1, `docs/round-n-campaigns-audit.md` D10). No
-- installation can have withdrawn them, because none has ever had them. `campaigns.manage`
-- is never sufficient on its own: every campaign command ALSO charges the permission of each
-- action it composes (`catalog.discounts.edit`, `catalog.pricing.edit`, ...), so the Sales
-- role, which already holds the discount key, gains nothing it could not already publish.
-- This migration deletes nothing and replaces nothing, and a DENY override still beats it,
-- because resolution subtracts DENY last.
--
-- `owner` holds every key; `observer` holds every LOW key; `sales` owns discounts.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'campaigns.view'),
        ('owner', 'campaigns.manage'),
        ('observer', 'campaigns.view'),
        ('sales', 'campaigns.view'),
        ('sales', 'campaigns.manage')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
