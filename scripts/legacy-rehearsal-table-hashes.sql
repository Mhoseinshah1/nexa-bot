-- Legacy migration: an EXACT per-table fingerprint of a NEXA database (WP-D8).
--
-- One `schema.table<TAB>rows<TAB>hash` line for every base table in `public` and `drizzle`
-- (the migration journal), in name order. The hash is two independent 64-bit sums over
-- md5(row::text) — order-independent and streaming, so it costs no memory on a large table
-- and does not depend on physical row order, which a pg_dump/pg_restore round trip changes.
-- Two databases with equal lines hold the same rows in every table: what the rollback must
-- prove ("restored = PRE", "the displaced database IS the post-import state"), where the
-- aggregate snapshot (legacy-rehearsal-checks.sql) only compares the figures it selects.
--
--   psql -X -q -At -F "$(printf '\t')" -v ON_ERROR_STOP=1 -d <db> -f scripts/legacy-rehearsal-table-hashes.sql
--
-- Read-only: run it inside a READ ONLY transaction. No row content is printed.

SET default_transaction_read_only = on;
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;

SELECT format(
  'SELECT %L, count(*), '
  || 'COALESCE(sum((''x'' || substr(md5(t::text), 1, 16))::bit(64)::bigint), 0)::text || '':'' || '
  || 'COALESCE(sum((''x'' || substr(md5(t::text), 17, 16))::bit(64)::bigint), 0)::text '
  || 'FROM %I.%I t',
  table_schema || '.' || table_name, table_schema, table_name)
FROM information_schema.tables
WHERE table_schema IN ('public', 'drizzle') AND table_type = 'BASE TABLE'
ORDER BY table_schema, table_name
\gexec

ROLLBACK;
