-- NEXA v095 PR-4 D: the backfill of the new `users.phone_verification.exempt` key to the seeded
-- roles that already exist, on the model of the channel exemption's (0163): `owner` holds every
-- key (ROLE_SEEDS), and `operator` takes it beside `users.channel_membership.exempt`, the
-- per-customer control it answers support questions with. The key is HIGH, so `observer`
-- gains nothing. Hand-written, so no snapshot accompanies it. In the `VALUES ('role', 'key')`
-- shape `role-seed-backfill-coverage.test.ts` reads.
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'users.phone_verification.exempt'),
        ('operator', 'users.phone_verification.exempt')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
