-- Legacy migration: LEGACY-side aggregate snapshot (Items 11, 12, 16).
--
-- The source half of the reconciliation in docs/legacy-migration/reconciliation.md. It
-- reads the MirzaBot schema (`user`, `invoice`) exactly as
-- docs/legacy-migration/sql-evidence.md names it, and returns aggregates only.
--
-- Run it against the RESTORED final dump, never the live MirzaBot server, as the
-- SELECT-only account, inside a READ ONLY transaction (both walls of sql-evidence.md):
--
--   mariadb --user=oldbot_ro --password --database=<restored schema> \
--           --batch --skip-column-names --safe-updates < scripts/legacy-rehearsal-source.sql
--
-- Output: one `metric<TAB>value` line per figure. No `id`, username, phone,
-- secret_code, config link or card is selected, and none may be added: this output goes
-- into the migration report. A single record is inspected locally, never pasted.
--
-- The live-invoice status set is the one every query in sql-evidence.md uses.

SET SESSION TRANSACTION READ ONLY;
START TRANSACTION READ ONLY;

-- Every value is CAST to CHAR: a UNION takes one type per column, and without the casts
-- the decimal sums would turn every count into `3.0000`, which no longer equals the NEXA
-- side's `3`.

-- Customers and the wallet source (user.Balance; wallet_transaction is never replayed).
SELECT 'users_total', CAST(COUNT(*) AS CHAR) FROM user
UNION ALL
SELECT 'users_id_valid', CAST(COALESCE(SUM(CAST(id AS CHAR) REGEXP '^[1-9][0-9]{0,19}$'), 0) AS CHAR) FROM user
UNION ALL
SELECT 'balance_sum', CAST(COALESCE(SUM(CAST(Balance AS DECIMAL(24,4))), 0) AS CHAR) FROM user
UNION ALL
SELECT 'balance_positive_users', CAST(COALESCE(SUM(CAST(Balance AS DECIMAL(24,4)) > 0), 0) AS CHAR) FROM user
UNION ALL
SELECT 'balance_positive_sum',
       CAST(COALESCE(SUM(IF(CAST(Balance AS DECIMAL(24,4)) > 0, CAST(Balance AS DECIMAL(24,4)), 0)), 0) AS CHAR)
FROM user
UNION ALL
SELECT 'balance_zero_users', CAST(COALESCE(SUM(CAST(Balance AS DECIMAL(24,4)) = 0), 0) AS CHAR) FROM user
UNION ALL
SELECT 'balance_negative_users', CAST(COALESCE(SUM(CAST(Balance AS DECIMAL(24,4)) < 0), 0) AS CHAR) FROM user
UNION ALL
SELECT 'balance_negative_sum',
       CAST(COALESCE(SUM(IF(CAST(Balance AS DECIMAL(24,4)) < 0, CAST(Balance AS DECIMAL(24,4)), 0)), 0) AS CHAR)
FROM user
UNION ALL
-- Non-zero: a fractional Toman balance cannot be a whole-minor-unit IRT opening, so the
-- importer must have decided something about every one of these. Expected 0.
SELECT 'balance_fractional_users',
       CAST(COALESCE(SUM(CAST(Balance AS DECIMAL(24,4)) <> FLOOR(CAST(Balance AS DECIMAL(24,4)))), 0) AS CHAR)
FROM user
UNION ALL
SELECT 'balance_null_users', CAST(COALESCE(SUM(Balance IS NULL), 0) AS CHAR) FROM user

-- Trials (Q2's two inputs, as totals).
UNION ALL
SELECT 'users_limit_usertest_zero_or_less',
       CAST(COALESCE(SUM(CAST(limit_usertest AS SIGNED) <= 0), 0) AS CHAR) FROM user
UNION ALL
SELECT 'users_with_test_invoice',
       CAST(COUNT(*) AS CHAR) FROM user u WHERE EXISTS (SELECT 1 FROM invoice i WHERE i.id_user = u.id AND i.is_test = 1)

-- Service candidates: live invoices (the P6 population) and their split.
UNION ALL
SELECT 'live_invoices_total', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
UNION ALL
SELECT 'live_invoices_test', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 1
UNION ALL
SELECT 'live_invoices_real', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
UNION ALL
SELECT 'live_real_missing_code_panel', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
  AND (code_panel IS NULL OR code_panel = '')
UNION ALL
SELECT 'live_real_productless', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
  AND (code_product IS NULL OR code_product = '')
UNION ALL
SELECT 'live_real_custom', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
  AND is_custom = 1
UNION ALL
-- Live invoices whose `id_invoice` falls outside the evidenced key shape (OQ-P4-01): the
-- map cannot record a decision for them, so a non-zero figure breaks the service closure
-- and needs a forward migration decided from the archive, never a widened guess.
SELECT 'live_invoices_key_unmappable', CAST(COUNT(*) AS CHAR) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume')
  AND (id_invoice IS NULL
       OR NOT (BINARY CAST(id_invoice AS CHAR) REGEXP '^([1-9][0-9]{6})?([0-9a-f]{4}|[0-9a-f]{8})$'))
UNION ALL
SELECT 'live_real_orphan', CAST(COUNT(*) AS CHAR) FROM invoice i LEFT JOIN user u ON u.id = i.id_user
WHERE i.Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND i.is_test = 0
  AND u.id IS NULL;

-- Grouped: live real invoices per legacy status and per panel CODE (a code such as
-- `bac6` is not a credential and may be reported; it is what the panel map is keyed on).
SELECT CONCAT('live_real_by_status:', Status), COUNT(*) FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
GROUP BY Status ORDER BY Status;

SELECT CONCAT('live_real_by_code_panel:', COALESCE(NULLIF(code_panel, ''), '<none>')), COUNT(*)
FROM invoice
WHERE Status IN ('active','disabled','disabledn','disablebyadmin','end_of_volume') AND is_test = 0
GROUP BY COALESCE(NULLIF(code_panel, ''), '<none>') ORDER BY 1;

ROLLBACK;
