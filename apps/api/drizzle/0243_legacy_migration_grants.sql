-- Mirza `.nxpkg` importer: the backfill of the four new `legacy.migration.*` /
-- `legacy.history.*` keys to the seeded `owner` role that already exists (ROLE_SEEDS:
-- `owner` holds every key). No other role: VIEW and HISTORY VIEW are MEDIUM, so `observer`
-- (every LOW key) does not hold them, MANAGE is HIGH and APPLY is CRITICAL, both
-- owner-only. Hand-written, so no snapshot accompanies it.
--
-- The keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'legacy.migration.view'),
        ('owner', 'legacy.migration.manage'),
        ('owner', 'legacy.migration.apply'),
        ('owner', 'legacy.history.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
