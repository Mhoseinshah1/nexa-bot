-- Backfill: `referrals.view` reaches the roles that already exist.
--
-- Hand-written, like 0031, 0055, 0064, 0071 and 0104, because `drizzle-kit` generates
-- from `schema.ts` and does not look at data. It changes no schema, so no snapshot
-- accompanies it and the drift check has nothing to compare.
--
-- `ensureSystemRoles` writes a seed's permissions only when it CREATES the role, and
-- never reasserts them, so that a permission an operator withdrew stays withdrawn. A key
-- newly added to a seeded role therefore does not reach an installation whose role
-- already exists; this migration is the remedy that function names.
--
-- WHY THIS IS SAFE TO BACKFILL
--
-- `referrals.view` is NEW in this release (WP9-A, `docs/wp9-referral-audit.md` F10). No
-- installation can have withdrawn it from any role, because none has ever had it. It is
-- LOW risk and read-only. This migration deletes nothing and replaces nothing, touches
-- neither `admin_roles` nor `admin_permission_overrides`, and a DENY override still beats
-- it, because resolution subtracts DENY last.
--
-- `owner` holds every key; `observer` holds every LOW key; `finance` reads the ledger the
-- commissions are credited to.
--
-- The VALUES-join shape matches the earlier backfills, because the seed/backfill coverage
-- guard reads the PAIRS out of this statement.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'referrals.view'),
        ('observer', 'referrals.view'),
        ('finance', 'referrals.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
