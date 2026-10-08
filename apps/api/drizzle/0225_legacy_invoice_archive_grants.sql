-- Mirza migration PR3: the backfill of the two new `legacy.invoices.*` keys to the seeded
-- `owner` role that already exists (ROLE_SEEDS: `owner` holds every key). No other role:
-- VIEW is MEDIUM, so `observer` (every LOW key) does not hold it, and PII is HIGH and
-- owner-only by default. Hand-written, so no snapshot accompanies it.
--
-- The keys are NEW in this release, so no installation can have withdrawn them, and a DENY
-- override still beats this.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'legacy.invoices.view'),
        ('owner', 'legacy.invoices.pii.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
