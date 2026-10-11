-- The isolated Mirza → NEXA rehearsal: INDEPENDENT counts, straight from the rehearsal
-- database (docs/legacy-migration/nxpkg-real-rehearsal.md §6). Read-only: SELECTs only,
-- inside a READ ONLY transaction. Run by `deploy/rehearsal/mirza-rehearsal.sh verify`.
--
-- Not the importer's own reconciliation (that is the RECONCILE step and the v2 report);
-- this is a second, separate reading of what the database actually holds, for the operator
-- to compare with the dry run's figures and with the converter's report on the Windows PC.
-- Output: one `key<TAB>count<TAB>sum` line per figure. Never a row's content.

\set ON_ERROR_STOP on
\pset format unaligned
\pset fieldsep '\t'
\pset tuples_only on

BEGIN TRANSACTION READ ONLY;

-- Customers: every one, and the ones carrying a Mirza user id.
SELECT 'customers', count(*), '' FROM customers;
SELECT 'customers_from_mirza', count(*), ''
  FROM legacy_import_map WHERE legacy_table = 'user' AND entity_type = 'CUSTOMER';

-- Money. Opening balances are credits with the one migration reason; nothing else may have
-- moved in a Fresh Migration (wallet_entries_other must be 0).
SELECT 'opening_credits', count(*), coalesce(sum(amount), 0)
  FROM wallet_entries WHERE reason = 'MIGRATION_OPENING_BALANCE' AND direction = 'CREDIT';
SELECT 'opening_debits', count(*), coalesce(sum(amount), 0)
  FROM wallet_entries WHERE reason = 'MIGRATION_OPENING_BALANCE' AND direction = 'DEBIT';
SELECT 'wallet_entries_other', count(*), coalesce(sum(amount), 0)
  FROM wallet_entries WHERE reason <> 'MIGRATION_OPENING_BALANCE';
SELECT 'wallet_entries_currency:' || currency, count(*), coalesce(sum(amount), 0)
  FROM wallet_entries GROUP BY currency ORDER BY 1;
SELECT 'legacy_debts', count(*), coalesce(sum(amount_minor), 0) FROM legacy_wallet_debts;
SELECT 'legacy_debts:' || state, count(*), coalesce(sum(amount_minor), 0)
  FROM legacy_wallet_debts GROUP BY state ORDER BY 1;

-- Nothing operational may exist that a migration does not create. Adoption records each
-- adopted service under a zero-amount LEGACY_ADOPTION order (never revenue): any other
-- origin, or a non-zero sum, is a finding.
SELECT 'orders:' || origin || ':' || state, count(*), coalesce(sum(total_amount), 0)
  FROM orders GROUP BY 1 ORDER BY 1;
SELECT 'payments', count(*), '' FROM payments;
SELECT 'bot_instances', count(*), '' FROM bot_instances;

-- Services: candidates by outcome, and the NEXA services adoption created.
SELECT 'service_candidates', count(*), '' FROM legacy_service_candidates;
SELECT 'service_candidates:' || outcome, count(*), ''
  FROM legacy_service_candidates GROUP BY outcome ORDER BY 1;
SELECT 'services', count(*), '' FROM services;
SELECT 'services:' || state, count(*), '' FROM services GROUP BY state ORDER BY 1;
SELECT 'services_trial', count(*), '' FROM services WHERE is_trial;

-- History: the invoice archive and every history record type.
SELECT 'invoice_archive', count(*), '' FROM legacy_invoice_archive;
SELECT 'invoice_archive_test', count(*), '' FROM legacy_invoice_archive WHERE is_test;
SELECT 'history', count(*), '' FROM legacy_history_records;
SELECT 'history:' || record_type, count(*), ''
  FROM legacy_history_records GROUP BY record_type ORDER BY 1;

-- Panels: in a rehearsal every panel is the stand-in (mirza-rehearsal.sh preflight).
SELECT 'panels:' || provider_type || ':' || status, count(*), '' FROM panels GROUP BY 1 ORDER BY 1;

-- The import itself and the standard backup.
SELECT 'nxpkg_imports:' || status, count(*), '' FROM legacy_nxpkg_imports GROUP BY 1 ORDER BY 1;
SELECT 'backup_runs:' || state, count(*), '' FROM backup_runs GROUP BY 1 ORDER BY 1;

ROLLBACK;
