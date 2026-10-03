-- Phase A2 (`docs/direct-message-audit.md`): what `drizzle-kit` does not model for 0170 —
-- the backfill of the two new `users.message.*` keys to the seeded roles that already
-- exist. Hand-written, so no snapshot accompanies it and the drift check has nothing to
-- compare.
--
-- WHY THE BACKFILL IS SAFE
--
-- Both keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this because resolution subtracts DENY last. `owner` holds every key;
-- `operator` and `support` hold the customer conversation (ROLE_SEEDS). Neither key is LOW,
-- so `observer` gains nothing.
--
-- ROLLBACK NOTE. The previous release does not know the notification kinds
-- `DIRECT_MESSAGE` / `DIRECT_MESSAGE_MEDIA`; its dispatcher DEFERS a kind it cannot render
-- (it never stamps or spends it), so queued direct messages simply wait. Before a rollback:
--   SELECT count(*) FROM customer_notifications
--    WHERE kind IN ('DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA') AND state = 'PENDING';
-- `botctl rollback` never restores the database (CLAUDE.md).

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'users.message.send'),
        ('owner', 'users.message.view'),
        ('operator', 'users.message.send'),
        ('operator', 'users.message.view'),
        ('support', 'users.message.send'),
        ('support', 'users.message.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
