-- TB5 (`docs/support-agent/tb5-assist.md`): the backfill of the new `support_ai.assist` key to
-- the seeded roles that already exist — `owner` (every key), `operator` and `support` (the roles
-- that hold the business conversations, ROLE_SEEDS). Hand-written, so no snapshot accompanies it.
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY override
-- still beats this. It grants a capability, not a behaviour: drafts are produced only while an
-- owner has configured the support AI out of `OFF`, and a draft is never sent by itself.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'support_ai.assist'),
        ('operator', 'support_ai.assist'),
        ('support', 'support_ai.assist')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
