-- Hand-written, data only: reseller credit is removed (owner decision, 2026-10-01 — no
-- reseller debt, no negative balances, no credit purchases; docs/reseller-phase3-closure.md
-- §5).
--
-- The new release already grants no credit whatever a row stores. This migration exists for
-- the replicas of the PREVIOUS release, which keep serving during a rolling update after the
-- migrations have run and until they are replaced. That code reads the stored limit — the
-- reseller's own, else the tier's — and extends credit only when it is POSITIVE. So every
-- tier's limit becomes 0 and every reseller's own limit becomes NULL (inherit the tier's 0),
-- and the previous release also computes an allowance of zero from the moment this commits.
-- A rollback to that release therefore extends no credit either.
--
-- Irreversible by design: the owner removed reseller credit, so nothing restores a limit.
-- Each non-zero value is recorded first, as an ordinary audit row on the entity it belonged
-- to (`reseller_tier.update` on the tier, `reseller.update` on the customer), so it shows in
-- the Web Admin's change history with its before and after. The pre-update backup holds the
-- rows as well.
--
-- No wallet entry, balance, order or payment is read or written. A balance already below
-- zero is a legacy debt and stays exactly as it is.
INSERT INTO "audit_logs" ("id", "tenant_id", "occurred_at", "actor_type", "actor_id", "actor_label",
                          "action", "entity_type", "entity_id", "before", "after", "reason",
                          "correlation_id", "source_surface", "result")
SELECT gen_random_uuid(), t."tenant_id", now(), 'SYSTEM_JOB', NULL,
       'migration:0155_reseller_credit_removed', 'reseller_tier.update', 'ResellerTier',
       t."id"::text,
       jsonb_build_object('creditLimit', jsonb_build_object('amount', t."credit_limit_amount"::text,
                                                            'currency', t."credit_limit_currency")),
       jsonb_build_object('creditLimit', jsonb_build_object('amount', '0',
                                                            'currency', t."credit_limit_currency")),
       'reseller credit removed by owner decision', 'migration-0155-reseller-credit-removed',
       'WORKER', 'SUCCESS'
  FROM "reseller_tiers" t
 WHERE t."credit_limit_amount" <> 0;
--> statement-breakpoint
INSERT INTO "audit_logs" ("id", "tenant_id", "occurred_at", "actor_type", "actor_id", "actor_label",
                          "action", "entity_type", "entity_id", "before", "after", "reason",
                          "correlation_id", "source_surface", "result")
SELECT gen_random_uuid(), r."tenant_id", now(), 'SYSTEM_JOB', NULL,
       'migration:0155_reseller_credit_removed', 'reseller.update', 'Customer',
       r."customer_id"::text,
       jsonb_build_object('creditLimit', jsonb_build_object('amount', r."credit_limit_amount"::text,
                                                            'currency', r."credit_limit_currency")),
       jsonb_build_object('creditLimit', NULL),
       'reseller credit removed by owner decision', 'migration-0155-reseller-credit-removed',
       'WORKER', 'SUCCESS'
  FROM "resellers" r
 WHERE r."credit_limit_amount" IS NOT NULL AND r."credit_limit_amount" <> 0;
--> statement-breakpoint
UPDATE "reseller_tiers"
   SET "credit_limit_amount" = 0,
       "updated_at" = now()
 WHERE "credit_limit_amount" <> 0;
--> statement-breakpoint
UPDATE "resellers"
   SET "credit_limit_amount" = NULL,
       "credit_limit_currency" = NULL,
       "updated_at" = now()
 WHERE "credit_limit_amount" IS NOT NULL OR "credit_limit_currency" IS NOT NULL;
