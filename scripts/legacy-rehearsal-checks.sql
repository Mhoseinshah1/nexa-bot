-- Legacy migration: NEXA-side aggregate snapshot (Items 11, 12, 15, 16).
--
-- ONE read-only snapshot of every figure the reconciliation, the rehearsal and the
-- rollback validation compare. Run it BEFORE the import, AFTER it, and AFTER any
-- restore; the reconciliation is the difference between snapshots, never a figure
-- read on its own. See docs/legacy-migration/reconciliation.md.
--
--   psql -X -q -At -F "$(printf '\t')" -v tenant=<slug> -f scripts/legacy-rehearsal-checks.sql
--
-- In a deployed installation (the file is read from the operator's checkout on stdin):
--
--   docker compose --env-file /etc/nexa/deploy.env -f /opt/nexa/deploy/compose.yml \
--     exec -T postgres psql -U nexa -d nexa -X -q -At -F "$(printf '\t')" -v tenant=<slug> \
--     -f - < scripts/legacy-rehearsal-checks.sql
--
-- Output: one `metric<TAB>value` line per figure. Aggregates only: no row identifier,
-- Telegram id, username, phone, subscription link or credential is selected, and none
-- may be added — this output is pasted into the migration report.
--
-- It cannot write. The whole snapshot is one REPEATABLE READ, READ ONLY transaction, so
-- every figure is from the same instant and a mistyped edit fails instead of applying.

\set ON_ERROR_STOP on
\set QUIET on

\if :{?tenant}
\else
  DO $$ BEGIN RAISE EXCEPTION 'legacy-rehearsal-checks: pass -v tenant=<slug>'; END $$;
\endif

BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH t AS (
  SELECT id, currency FROM tenants WHERE slug = :'tenant'
),
signed AS (
  SELECT w.customer_id, w.reason, w.currency,
         CASE WHEN w.direction = 'CREDIT' THEN w.amount ELSE -w.amount END AS signed_amount
  FROM wallet_entries w JOIN t ON w.tenant_id = t.id
),
balances AS (
  SELECT s.customer_id, SUM(s.signed_amount) AS balance
  FROM signed s JOIN t ON s.currency = t.currency
  GROUP BY s.customer_id
),
openings AS (
  SELECT w.*, c.telegram_user_id
  FROM wallet_entries w
  JOIN t ON w.tenant_id = t.id
  JOIN customers c ON c.tenant_id = w.tenant_id AND c.id = w.customer_id
  WHERE w.reason = 'MIGRATION_OPENING_BALANCE'
),
adoptions AS (
  SELECT o.* FROM orders o JOIN t ON o.tenant_id = t.id WHERE o.origin = 'LEGACY_ADOPTION'
),
adopted_services AS (
  SELECT s.* FROM services s JOIN adoptions a ON a.tenant_id = s.tenant_id AND a.id = s.order_id
),
metrics(metric, value) AS (
  -- 0. The tenant itself. Exactly 1, or every figure below is about nothing.
            SELECT 'tenant_found', (SELECT count(*) FROM t)::text

  -- 1. Customers (Item 12: the customer-category closure is this delta against the map).
  UNION ALL SELECT 'customers_total',
              (SELECT count(*) FROM customers c JOIN t ON c.tenant_id = t.id)::text

  -- 2. Wallet (Item 12: the wallet equation). Selling currency only; any other currency
  --    is counted separately so it cannot hide inside the total.
  UNION ALL SELECT 'wallet_entries_total', (SELECT count(*) FROM signed)::text
  UNION ALL SELECT 'wallet_signed_total_minor',
              (SELECT COALESCE(SUM(balance), 0) FROM balances)::text
  UNION ALL SELECT 'wallet_entries_other_currency',
              (SELECT count(*) FROM signed s JOIN t ON s.currency <> t.currency)::text
  UNION ALL SELECT 'wallet_customers_positive',
              (SELECT count(*) FROM balances WHERE balance > 0)::text
  UNION ALL SELECT 'wallet_customers_negative',
              (SELECT count(*) FROM balances WHERE balance < 0)::text
  UNION ALL SELECT 'wallet_negative_total_minor',
              (SELECT COALESCE(SUM(balance), 0) FROM balances WHERE balance < 0)::text

  -- 3. Opening balances (P2). Opening is NOT revenue: it is its own reason and its own
  --    report group, and none of these rows names an order or a payment.
  UNION ALL SELECT 'opening_entries_total', (SELECT count(*) FROM openings)::text
  UNION ALL SELECT 'opening_signed_total_minor',
              (SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
                 FROM openings)::text
  UNION ALL SELECT 'opening_credit_entries',
              (SELECT count(*) FROM openings WHERE direction = 'CREDIT')::text
  UNION ALL SELECT 'opening_debit_entries',
              (SELECT count(*) FROM openings WHERE direction = 'DEBIT')::text
  -- Must be 0: one opening per customer (the partial unique index says so; this proves it).
  UNION ALL SELECT 'opening_customers_with_duplicates',
              (SELECT count(*) FROM (SELECT customer_id FROM openings
                                     GROUP BY customer_id HAVING count(*) > 1) d)::text
  -- Must be 0: every opening's reference is derived from ITS customer's Telegram id.
  UNION ALL SELECT 'opening_reference_mismatch',
              (SELECT count(*) FROM openings
                WHERE reference IS DISTINCT FROM 'legacy:opening:' || telegram_user_id::text)::text
  -- Must be 0: an opening names no order, payment, reversal or admin.
  UNION ALL SELECT 'opening_linked_to_money',
              (SELECT count(*) FROM openings
                WHERE order_id IS NOT NULL OR payment_id IS NOT NULL
                   OR reverses_entry_id IS NOT NULL OR actor_admin_id IS NOT NULL)::text

  -- 4. Revenue (Item 12: opening != revenue, adoption != revenue). These figures must be
  --    IDENTICAL before and after an import: an import creates no sale and no payment.
  UNION ALL SELECT 'orders_total',
              (SELECT count(*) FROM orders o JOIN t ON o.tenant_id = t.id)::text
  UNION ALL SELECT 'sale_orders_paid',
              (SELECT count(*) FROM orders o JOIN t ON o.tenant_id = t.id
                WHERE o.origin = 'STANDARD' AND o.state = 'PAID')::text
  UNION ALL SELECT 'sale_orders_paid_total_minor',
              (SELECT COALESCE(SUM(o.total_amount), 0) FROM orders o JOIN t ON o.tenant_id = t.id
                WHERE o.origin = 'STANDARD' AND o.state = 'PAID')::text
  UNION ALL SELECT 'payments_total',
              (SELECT count(*) FROM payments p JOIN t ON p.tenant_id = t.id)::text
  UNION ALL SELECT 'wallet_topup_signed_total_minor',
              (SELECT COALESCE(SUM(signed_amount), 0) FROM signed
                WHERE reason IN ('TOPUP_GATEWAY', 'TOPUP_RECEIPT', 'TOPUP_STARS', 'TOPUP_CRYPTO'))::text

  -- 5. Adoption (P6). Zero totals by CHECK; proven again here.
  UNION ALL SELECT 'adoption_orders', (SELECT count(*) FROM adoptions)::text
  UNION ALL SELECT 'adoption_orders_nonzero_total',
              (SELECT count(*) FROM adoptions
                WHERE subtotal_amount <> 0 OR discount_amount <> 0 OR total_amount <> 0)::text
  UNION ALL SELECT 'adopted_services', (SELECT count(*) FROM adopted_services)::text
  UNION ALL SELECT 'adopted_services_without_subscription_url',
              (SELECT count(*) FROM adopted_services WHERE subscription_url IS NULL)::text
  UNION ALL SELECT 'services_total',
              (SELECT count(*) FROM services s JOIN t ON s.tenant_id = t.id)::text

  -- 6. Provider writes. NEXA reaches a provider for a write only through a
  --    provisioning_operations row; an import that wrote none asked for none. Must be 0
  --    for adopted services, and the total must be unchanged across the import window.
  UNION ALL SELECT 'provisioning_operations_total',
              (SELECT count(*) FROM provisioning_operations p JOIN t ON p.tenant_id = t.id)::text
  UNION ALL SELECT 'adopted_services_with_provisioning_operation',
              (SELECT count(*) FROM adopted_services s
                WHERE EXISTS (SELECT 1 FROM provisioning_operations p
                               WHERE p.tenant_id = s.tenant_id AND p.service_id = s.id))::text
  UNION ALL SELECT 'username_reservations_total',
              (SELECT count(*) FROM service_username_reservations r JOIN t ON r.tenant_id = t.id)::text

  -- 7. Products and trials (Items 4, 5).
  UNION ALL SELECT 'hidden_products',
              (SELECT count(*) FROM products p JOIN t ON p.tenant_id = t.id
                WHERE p.audience = 'HIDDEN')::text
  UNION ALL SELECT 'legacy_product_shapes',
              (SELECT count(*) FROM legacy_product_shapes l JOIN t ON l.tenant_id = t.id)::text
  UNION ALL SELECT 'legacy_product_shapes_unresolved',
              (SELECT count(*) FROM legacy_product_shapes l JOIN t ON l.tenant_id = t.id
                WHERE l.tariff_status <> 'RESOLVED')::text
  UNION ALL SELECT 'trial_limit_overrides',
              (SELECT count(*) FROM trial_limit_overrides o JOIN t ON o.tenant_id = t.id)::text
  UNION ALL SELECT 'trial_grants',
              (SELECT count(*) FROM trial_grants g JOIN t ON g.tenant_id = t.id)::text
  UNION ALL SELECT 'legacy_trial_eligibility',
              (SELECT count(*) FROM legacy_trial_eligibility e JOIN t ON e.tenant_id = t.id)::text

  -- 8. Reminders and customer messages (Item 8: no historical reminder storm).
  UNION ALL SELECT 'service_reminders',
              (SELECT count(*) FROM service_reminders r JOIN t ON r.tenant_id = t.id)::text
  UNION ALL SELECT 'customer_notifications',
              (SELECT count(*) FROM customer_notifications n JOIN t ON n.tenant_id = t.id)::text

  -- 9. Import metadata (P4).
  UNION ALL SELECT 'legacy_import_runs',
              (SELECT count(*) FROM legacy_import_runs r JOIN t ON r.tenant_id = t.id)::text
  UNION ALL SELECT 'legacy_import_runs_running',
              (SELECT count(*) FROM legacy_import_runs r JOIN t ON r.tenant_id = t.id
                WHERE r.status = 'RUNNING')::text
  UNION ALL SELECT 'legacy_import_map',
              (SELECT count(*) FROM legacy_import_map m JOIN t ON m.tenant_id = t.id)::text

  -- 10. Schema state: a restore must come back at the migration level it left.
  UNION ALL SELECT 'schema_migrations_applied',
              (SELECT count(*) FROM drizzle.__drizzle_migrations)::text
)
SELECT metric, value FROM metrics

-- Grouped figures, one line per group, after the fixed ones.
UNION ALL
SELECT 'legacy_trial_decision:' || e.decision, count(*)::text
FROM legacy_trial_eligibility e JOIN t ON e.tenant_id = t.id
GROUP BY e.decision

UNION ALL
SELECT 'map:' || m.legacy_table || ':' || m.status || ':' || COALESCE(m.reason_code, '-'),
       count(*)::text
FROM legacy_import_map m JOIN t ON m.tenant_id = t.id
GROUP BY m.legacy_table, m.status, m.reason_code

UNION ALL
SELECT 'adopted_services_state:' || s.state, count(*)::text
FROM adopted_services s
GROUP BY s.state

ORDER BY 1;

ROLLBACK;
