-- Phase 6B PR-3 (ADR-0039, the open data export): the backfill of the new `data.export` key to
-- the seeded `owner` roles that already exist, on the model of 0320: `owner` holds every key
-- (ROLE_SEEDS). Nobody else: the key is CRITICAL, so `operator` and `observer` gain nothing.
-- Hand-written, so no snapshot accompanies it. In the `VALUES ('role', 'key')` shape
-- `role-seed-backfill-coverage.test.ts` reads.
--
-- A hosted bot's own owner is the audience: the key is what lets them ask for, and download,
-- their tenant's data. The installation's own owner holds it too (ALL), but the service refuses
-- the installation tenant (`data_export.not_hosted`) and his session is not shown the key.
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'data.export')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
