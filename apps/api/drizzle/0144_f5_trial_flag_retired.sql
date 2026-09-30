-- F5, hand-written: the `trials` feature flag is retired, and each panel's own trial
-- (`panel_trial_configs.enabled`, R1) is the one switch in front of a trial.
--
-- Until now a customer was offered a panel's trial only while BOTH were on. A tenant whose
-- flag was off could still have panel trials switched on — migration 0142 carried a trial
-- product across as an enabled panel trial whatever the flag said, and an operator could
-- enable one on the panel's tab with the flag off. Once the flag stops being read those
-- panels would start offering free service on the next release. So, once: every panel
-- trial of a tenant whose flag is OFF is switched off here, and each tenant keeps the
-- behaviour it had — a tenant whose flag was on keeps every panel as it was, and one whose
-- flag was off offers no trial until an operator enables one on a panel's tab.
--
-- The flag's effective value is its stored row, or its registry default when there is no
-- row, and that default was OFF: no row means off.
--
-- The revision moves on, so a trial tab open in a browser across the upgrade is told the
-- trial changed rather than silently writing its old `enabled` back. Traffic, hours and
-- label are untouched: re-enabling a panel offers exactly what it was configured with.
--
-- The `feature_flag_states` rows are NOT deleted: the release before this one still reads
-- them, and a rollback must find each tenant's switch where it left it
-- (`docs/deployment.md`, the F5 rollback section).
UPDATE "panel_trial_configs" c
   SET "enabled" = false,
       "revision" = c."revision" + 1,
       "updated_at" = now()
 WHERE c."enabled"
   AND NOT EXISTS (
     SELECT 1
       FROM "feature_flag_states" f
      WHERE f."tenant_id" = c."tenant_id"
        AND f."flag_key" = 'trials'
        AND f."enabled"
   );
