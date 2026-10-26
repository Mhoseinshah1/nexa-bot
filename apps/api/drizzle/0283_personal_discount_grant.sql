-- R10 D3: the backfill of the new `users.discount.edit` key to the seeded `owner` role that
-- already exists (ROLE_SEEDS: `owner` holds every key). No other role: the key is HIGH and
-- moves money (a standing percentage off one customer's purchases and renewals), so an owner
-- grants it to another role deliberately. Hand-written, so no snapshot accompanies it.
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", 'users.discount.edit'
FROM "roles" r
WHERE r."is_system" = true
  AND r."key" = 'owner'
ON CONFLICT DO NOTHING;
