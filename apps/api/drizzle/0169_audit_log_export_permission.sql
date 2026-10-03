-- Phase D1, the professional audit log (`docs/audit-log.md`): the backfill of the one new
-- permission, `audit.export`, to the seeded owner roles that already exist. Hand-written, so
-- no snapshot accompanies it and the drift check has nothing to compare.
--
-- Nothing else in this phase is a migration. The audit log's model is unchanged — no column,
-- no constraint, no trigger — and its four tenant-led keyset indexes are built CONCURRENTLY by
-- `ONLINE_INDEXES` after the migrator, because `audit_logs` is written by nearly every
-- business transaction and a blocking build would hold all of them during `botctl update`.
--
-- WHY THE BACKFILL IS SAFE
--
-- The key is NEW in this release, so no installation can have withdrawn it, and a DENY
-- override still beats this because resolution subtracts DENY last. It is HIGH, so it reaches
-- the owner alone; `observer` (LOW keys) and `finance` (`audit.view`) gain nothing.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage guard
-- reads the PAIRS out of this statement.
INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'audit.export')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
