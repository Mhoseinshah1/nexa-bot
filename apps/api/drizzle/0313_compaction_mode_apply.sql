-- NEXA v0.9.7 (owner decision): the data compaction removes by default.
--
-- `retention.compaction_mode` defaulted to DRY_RUN («فقط شمارش») until this release; the
-- registry default is now APPLY («حذف»), so an installation that never stored the mode moves
-- with the default and needs nothing here (absence of a row IS the default). This moves the
-- installations that STORED DRY_RUN (often the old default written back by a settings
-- save) to APPLY too, as the owner asked for new and existing installations alike.
--
-- What it changes and what it does not:
--   - only the mode row, only where it says exactly "DRY_RUN"; an APPLY row is untouched;
--   - the days settings are NOT rewritten: a stored value is an operator's choice and keeps
--     its meaning; an unstored one takes the new defaults (7 / 30 / 30) from the registry;
--   - the version advances and the row no longer names an administrator, so the settings
--     page does not attribute this change to whoever saved the form last;
--   - nothing is deleted here and nobody is told anything: the worker's next daily pass (a
--     SYSTEM_JOB, `maintenance.run`, refused during a recovery or a backup) does the removing
--     in its audited keyset batches, and the compaction sends no customer message.
--
-- AUDIT: one `settings.set` row per changed tenant, written BEFORE the update with the values
-- it changes, in the pattern of 0271 (the settings service's own action and shape). No outbox
-- event: a migration announces nothing.
INSERT INTO "audit_logs" ("id", "tenant_id", "occurred_at", "actor_type", "actor_id", "actor_label",
                          "action", "entity_type", "entity_id", "before", "after", "reason",
                          "correlation_id", "source_surface", "result")
SELECT gen_random_uuid(), sv."tenant_id", now(), 'SYSTEM_JOB', NULL,
       'migration:0311_compaction_mode_apply',
       'settings.set', 'Setting', 'retention.compaction_mode',
       jsonb_build_object('value', 'DRY_RUN', 'source', 'TENANT'),
       jsonb_build_object('value', 'APPLY', 'source', 'TENANT'),
       'v0.9.7 owner decision: the data compaction removes by default on new and existing installations',
       'migration-0311-compaction-mode-apply', 'WORKER', 'SUCCESS'
  FROM "setting_values" sv
 WHERE sv."setting_key" = 'retention.compaction_mode'
   AND sv."value" = '"DRY_RUN"'::jsonb;
--> statement-breakpoint
UPDATE setting_values
   SET value = '"APPLY"'::jsonb,
       version = version + 1,
       updated_at = now(),
       updated_by_admin_id = NULL
 WHERE setting_key = 'retention.compaction_mode'
   AND value = '"DRY_RUN"'::jsonb;
