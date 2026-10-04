-- TB2 (ADR-0033, `docs/support-agent/tb2-conversations.md`): what `drizzle-kit` does not
-- model for 0197 — the backfill of the two new `business_chats.*` keys to the seeded roles
-- that already exist. Hand-written, so no snapshot accompanies it and the drift check has
-- nothing to compare.
--
-- WHY THE BACKFILL IS SAFE
--
-- Both keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this because resolution subtracts DENY last. `owner` holds every key;
-- `operator` and `support` hold the customer conversation (ROLE_SEEDS). `observer` holds every
-- LOW key, and `business_chats.view` is LOW.
--
-- ROLLBACK NOTE. The previous release has no business conversation tables, routes or lane;
-- the rows written here are inert to it. `botctl rollback` never restores the database
-- (CLAUDE.md).

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'business_chats.view'),
        ('owner', 'business_chats.reply'),
        ('operator', 'business_chats.view'),
        ('operator', 'business_chats.reply'),
        ('support', 'business_chats.view'),
        ('support', 'business_chats.reply'),
        ('observer', 'business_chats.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
