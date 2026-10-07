-- Legacy migration: the FREEZE PROOF over EVERY table of the legacy database (Mirza
-- migration PR1; docs/legacy-migration/cutover-runbook.md steps 7 and 9).
--
-- One `CHECKSUM TABLE` over every base table of the current database, in table-name byte
-- order — not only `user` and `invoice`. Every read set NEXA has or will have (the v1
-- import read set; later products, invoice archive) reads a subset of these tables, so a
-- write to ANY of them between the freeze and the switch changes a value here. Run it at
-- the freeze (step 7) and on the restored copy (step 9) and compare the two outputs
-- line by line; `legacy-import inventory` prints the same table list for review.
--
--   mysql   --user=oldbot_ro --password --batch oldbot < scripts/legacy-freeze-checksum.sql
--   mariadb --user=oldbot_ro --password --batch oldbot < scripts/legacy-freeze-checksum.sql
--
-- Read-only: it sets two SESSION variables, builds the statement from information_schema
-- and runs it. No row content is printed: CHECKSUM TABLE returns one number per table. It
-- needs SELECT on the database and nothing else, and it runs under `read_only` and
-- `super_read_only`. The values are engine- and row-format-specific: compare them only
-- between servers of the same engine and major version (the runbook's throwaway server).

SET SESSION TRANSACTION READ ONLY;
SET SESSION group_concat_max_len = 1048576;
SELECT CONCAT('CHECKSUM TABLE ',
              GROUP_CONCAT(CONCAT('`', REPLACE(TABLE_NAME, '`', '``'), '`')
                           ORDER BY CAST(TABLE_NAME AS BINARY) SEPARATOR ', '))
  INTO @nexa_freeze_checksum
  FROM information_schema.TABLES
 WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE';
PREPARE nexa_freeze_checksum FROM @nexa_freeze_checksum;
EXECUTE nexa_freeze_checksum;
DEALLOCATE PREPARE nexa_freeze_checksum;
