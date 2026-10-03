-- Program §13 (the Service Operations Center): the backfill of the two new keys to the seeded
-- roles that already exist. Hand-written, like 0148: it changes no schema, so no snapshot
-- accompanies it and the drift check has nothing to compare.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- Both keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this because resolution subtracts DENY last. `owner` holds every key.
-- `services.grant` gives a service free traffic or time and `services.mass.status` suspends
-- or resumes many services at once — both HIGH, so `observer` (LOW keys) gains nothing, and
-- no other seeded role is given either. `services.mass.status` is never sufficient on its
-- own: every mass status change also charges `services.edit`.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'services.grant'),
        ('owner', 'services.mass.status')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
