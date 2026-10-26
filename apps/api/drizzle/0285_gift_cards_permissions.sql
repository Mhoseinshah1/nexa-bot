-- Backfill: the four gift-card permissions reach the `owner` role that already exists.
--
-- Hand-written, like 0109, 0148 and 0175, because `drizzle-kit` generates from `schema.ts`
-- and does not look at data. It changes no schema, so no snapshot accompanies it and the
-- drift check has nothing to compare.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and never
-- reasserts them, so that a permission an operator withdrew stays withdrawn. A key newly
-- added to a seeded role therefore does not reach an installation whose role already exists;
-- this migration is the remedy that function names.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- All four keys are NEW in this release (R10 D4), so no installation can have withdrawn them,
-- and a DENY override still beats this because resolution subtracts DENY last. `owner` holds
-- every key. `gift_cards.view` is MEDIUM, so `observer` (LOW keys) gains nothing; create and
-- export are CRITICAL and disable is HIGH, and no other seeded role is given any of them.
-- Holding them does nothing while the `gift_cards` feature is off, which is its default.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'gift_cards.view'),
        ('owner', 'gift_cards.create'),
        ('owner', 'gift_cards.export'),
        ('owner', 'gift_cards.disable')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
