-- Phase 6A PR-3 (D1): the backfill of the new `hosting.manage` key to the seeded `owner` roles
-- that already exist, on the model of 0309: `owner` holds every key (ROLE_SEEDS). Nobody else:
-- the key is CRITICAL, so `operator` and `observer` gain nothing. Hand-written, so no snapshot
-- accompanies it. In the `VALUES ('role', 'key')` shape `role-seed-backfill-coverage.test.ts`
-- reads.
--
-- Holding the key is not enough to reach the creator panel: `HostingService` also requires the
-- installation tenant's scope and the system owner role, so a hosted bot's own owner (who holds
-- every key in their own tenant) is refused.
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'hosting.manage')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
