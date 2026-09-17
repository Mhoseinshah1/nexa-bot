-- Backfill: every existing tenant gets the manual payment route it is already using,
-- and the two roles that own payment configuration get the keys to it.
--
-- Hand-written, like 0011, 0031, 0055 and 0064, because `drizzle-kit` generates from
-- `schema.ts` and does not look at data. No snapshot accompanies it for the same reason:
-- it changes no schema, so the drift check has nothing to compare.
--
-- ============================================================================
-- PART 1 — the route row
-- ============================================================================
--
-- WHY THIS IS NOT OPTIONAL
--
-- 0070 adds `payment_gateways`, and `PaymentGatewayService` is what the wallet top-up
-- path now consults before issuing an invoice. On a FRESH install `ensureTenantGateways`
-- writes the row during provisioning. On an UPGRADED install nothing would, so without
-- this every existing installation would answer its customers' next top-up with
-- `PAYMENT_GATEWAY_UNAVAILABLE` — a release that silently stops taking money, which is
-- the exact defect class 0055 repaired for `receipt_reviewer` and 0064 for the accounts
-- surface.
--
-- WHAT IT WRITES, AND WHAT IT REFUSES TO INVENT
--
-- `status = 'ACTIVE'`, because the route IS active on these installations today — they
-- have been taking manual transfers since 4C, and writing `DISABLED` would be this
-- migration switching off a live payment route to be cautious.
--
-- Everything else is the zero row: no amount bounds, no eligibility thresholds, sort
-- order 0. That is "no additional condition", which is precisely the behaviour these
-- installations have now, so the upgrade changes nothing a customer can observe.
--
-- `display_name` is NULL on purpose, and the column is nullable for this reason. NULL
-- means "the product's own name for this route", which the surface renders from a
-- template key. A Persian label typed into this file would be a customer-facing string
-- in the one place `docs/conventions.md`'s template rule cannot reach it, and the
-- i18n key checker does not read SQL.
--
-- Idempotent by the primary key: `(tenant_id, provider)` already exists on a tenant
-- provisioned after 0070, and `ON CONFLICT DO NOTHING` leaves whatever the operator has
-- since configured. Re-running this must never reset a route somebody has tuned.

INSERT INTO "payment_gateways" ("tenant_id", "provider", "status")
SELECT t."id", 'MANUAL_TRANSFER', 'ACTIVE'
FROM "tenants" t
ON CONFLICT DO NOTHING;

-- ============================================================================
-- PART 2 — the role grants
-- ============================================================================
--
-- `ensureSystemRoles` writes a seed's permissions when the role is CREATED and never
-- reasserts them, and says at length why: reasserting on every boot would silently
-- restore a permission an operator had deliberately withdrawn. The consequence it names
-- is this one — a permission newly added to a seeded role does NOT reach installations
-- that already have that role — and the remedy it names is a migration that says what it
-- is doing.
--
-- WHY THIS ONE IS SAFE TO BACKFILL
--
-- The argument 0011 and 0031 make, in its strongest form: `payments.gateways.view` and
-- `payments.gateways.edit` are NEW keys in this release. No installation can have had
-- either withdrawn from any role, because no installation has ever had either to
-- withdraw. Nothing here deletes a permission, replaces a permission set, touches
-- `admin_roles`, or touches `admin_permission_overrides` — and a DENY override still
-- beats this grant, because resolution subtracts DENY last.
--
-- `observer` is absent from the list below and is not an omission: it is seeded with
-- every LOW permission, so `payments.gateways.view` reaches it through `READ_ONLY`
-- rather than through a pair named here. A role this migration does not find is not
-- missed either — `ensureSystemRoles` runs after migrations at every boot and creates a
-- missing seeded role with its full current permission set.
--
-- The VALUES-join shape matches 0011, 0031, 0055 and 0064, and not by taste: the
-- seed/backfill coverage guard reads the PAIRS out of this statement, and a shape it
-- does not recognise yields nothing — which fails that test rather than quietly
-- shrinking it.

INSERT INTO "role_permissions" ("tenant_id", "role_id", "permission_key")
SELECT r."tenant_id", r."id", p."key"
FROM "roles" r
JOIN (VALUES
        ('owner', 'payments.gateways.view'),
        ('owner', 'payments.gateways.edit'),
        ('finance', 'payments.gateways.view'),
        ('finance', 'payments.gateways.edit'),
        ('operator', 'payments.gateways.view'),
        ('observer', 'payments.gateways.view')
     ) AS p("role_key", "key")
  ON p."role_key" = r."key"
WHERE r."is_system" = true
ON CONFLICT DO NOTHING;
