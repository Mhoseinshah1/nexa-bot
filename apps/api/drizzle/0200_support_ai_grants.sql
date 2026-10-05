-- TB4 (ADR-0034 §8, `docs/support-agent/tb4-provider-foundation.md`): what `drizzle-kit` does
-- not model for 0199 — the backfill of the two new `support_ai.*` keys to the seeded roles that
-- already exist. Hand-written, so no snapshot accompanies it.
--
-- WHY ONLY `owner`
--
-- `support_ai.configure` stores a third party's key and spends money (HIGH);
-- `support_ai.auto_reply` lets the AI answer customers on its own (CRITICAL). ROLE_SEEDS grants
-- neither to any role but `owner`, which holds every key. Both keys are NEW in this release, so
-- no installation can have withdrawn them, and a DENY override still beats this.
--
-- This grants an AUTHORITY, not a behaviour: every tenant's support AI stays `OFF` until an
-- owner configures it (program §49). Nothing here, and no migration, sets AUTO_REPLY_SAFE.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'support_ai.configure'),
        ('owner', 'support_ai.auto_reply')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
