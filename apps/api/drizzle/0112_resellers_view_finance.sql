-- Backfill: `finance` gains `resellers.view` on the installations whose role exists.
--
-- Hand-written, like 0109, because `drizzle-kit` generates from `schema.ts` and does not
-- look at data. It changes no schema, so no snapshot accompanies it.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, so a key
-- newly added to a seeded role reaches no existing installation without this.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- `resellers.view` has existed since Phase 1, but `finance` never held it, and before this
-- release there was nothing behind it to read: no reseller was ever written, and the Web
-- Admin page was a placeholder. So no operator can have withdrawn it from `finance` on
-- purpose. It is LOW risk and read-only. A DENY override still beats it, because
-- resolution subtracts DENY last. `owner` and `observer` already hold it.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage
-- guard reads the PAIRS out of this statement.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('finance', 'resellers.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
