-- Customer 360 workspace counts (roadmap B5, review N4 on PR #240): does each per-customer
-- count reach ONE customer's rows, or walk the tenant's whole backlog in that state?
--
-- Run against a DISPOSABLE, migrated database (it creates and drops x_* scratch tables):
--   psql "$TEST_DATABASE_URL" -f scripts/explain-customer360-counts.sql
--
-- The x_* tables are `LIKE ... INCLUDING INDEXES` copies, so they carry every index of the
-- real table (the online `business_conversations_tenant_customer_handoff_idx` included,
-- which `pnpm db:migrate` builds) and no foreign key, which lets synthetic rows in without a
-- superuser. The queries are the reader's (`drizzle-customer-insight.reader.ts`) verbatim.
--
-- Recorded result (PostgreSQL 16, 2026-10-07):
--   payments UNKNOWN    Bitmap Index Scan on the (customer_id, created_at, id) copy, 6 rows
--   services UNRECONCILED  Index Scan on the (customer_id, created_at, id) copy, 3 rows
--   handoffs count/newest  Index (Only) Scan on the (tenant_id, customer_id) partial copy
--   handoffs WITHOUT that index: Seq Scan, 39 998 rows removed by filter
\set ON_ERROR_STOP 1
DROP TABLE IF EXISTS x_payments, x_services, x_convs;
CREATE TABLE x_payments (LIKE payments INCLUDING DEFAULTS INCLUDING INDEXES);
CREATE TABLE x_services (LIKE services INCLUDING DEFAULTS INCLUDING INDEXES);
CREATE TABLE x_convs (LIKE business_conversations INCLUDING DEFAULTS INCLUDING INDEXES);
-- one tenant, 20 000 customers; customer uuids derived from g
INSERT INTO x_payments (id, tenant_id, customer_id, state, method, amount, currency, reference, created_at)
SELECT gen_random_uuid(), '00000000-0000-7000-8000-000000000001',
       ('00000000-0000-7000-8000-' || lpad(to_hex(g % 20000), 12, '0'))::uuid,
       CASE WHEN g % 24 = 0 THEN 'UNKNOWN' ELSE 'PENDING' END, 'WALLET', 100, 'IRT', 'r' || g,
       now() - (g || ' seconds')::interval
  FROM generate_series(1, 120000) g;
INSERT INTO x_services (id, tenant_id, customer_id, order_id, panel_id, state, provider_username, traffic_limit_bytes, created_at)
SELECT gen_random_uuid(), '00000000-0000-7000-8000-000000000001',
       ('00000000-0000-7000-8000-' || lpad(to_hex(g % 20000), 12, '0'))::uuid, gen_random_uuid(), gen_random_uuid(),
       CASE WHEN g <= 20000 THEN 'UNRECONCILED' ELSE 'PENDING_PROVISION' END, 'u' || g, 0, now() - (g || ' seconds')::interval
  FROM generate_series(1, 60000) g;
INSERT INTO x_convs (id, tenant_id, bot_instance_id, owner_telegram_user_id, chat_id, connection_row_id, peer_telegram_user_id, state, handoff_reason, customer_id, last_message_at)
SELECT gen_random_uuid(), '00000000-0000-7000-8000-000000000001', gen_random_uuid(), '1', g::text, gen_random_uuid(), '1',
       CASE WHEN g % 4 = 0 THEN 'HANDOFF_REQUIRED' ELSE 'AI_ACTIVE' END,
       CASE WHEN g % 4 = 0 THEN 'HUMAN_REQUESTED' END,
       ('00000000-0000-7000-8000-' || lpad(to_hex(g % 20000), 12, '0'))::uuid, now() - (g || ' seconds')::interval
  FROM generate_series(1, 40000) g;
ANALYZE x_payments; ANALYZE x_services; ANALYZE x_convs;
\echo === payments UNKNOWN (backlog 5000)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*)::int AS n FROM (SELECT 1 FROM x_payments p WHERE p.tenant_id = '00000000-0000-7000-8000-000000000001' AND p.customer_id = '00000000-0000-7000-8000-000000000000' AND p.state = 'UNKNOWN' LIMIT 1000) capped;
\echo === services UNRECONCILED (backlog 20000)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*)::int AS n FROM (SELECT 1 FROM x_services s WHERE s.tenant_id = '00000000-0000-7000-8000-000000000001' AND s.customer_id = '00000000-0000-7000-8000-000000000005' AND s.state = 'UNRECONCILED' LIMIT 1000) capped;
\echo === handoffs count (backlog 10000)
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*)::int AS n FROM (SELECT 1 FROM x_convs c WHERE c.tenant_id = '00000000-0000-7000-8000-000000000001' AND c.customer_id = '00000000-0000-7000-8000-000000000004' AND c.state = 'HANDOFF_REQUIRED' LIMIT 1000) capped;
\echo === handoffs newest
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT c.id FROM x_convs c WHERE c.tenant_id = '00000000-0000-7000-8000-000000000001' AND c.customer_id = '00000000-0000-7000-8000-000000000004' AND c.state = 'HANDOFF_REQUIRED' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id DESC LIMIT 1;
\echo === handoffs WITHOUT the new index
DROP INDEX x_convs_tenant_id_customer_id_idx;
EXPLAIN (ANALYZE, BUFFERS, COSTS OFF) SELECT count(*)::int AS n FROM (SELECT 1 FROM x_convs c WHERE c.tenant_id = '00000000-0000-7000-8000-000000000001' AND c.customer_id = '00000000-0000-7000-8000-000000000004' AND c.state = 'HANDOFF_REQUIRED' LIMIT 1000) capped;
DROP TABLE x_payments, x_services, x_convs;
