-- NEXA-OWNER-BATCH-1 PR-5: each online gateway's late-credit switch becomes a policy.
--
-- The five `payments.late_credit.*_enabled` settings keep their keys (every route descriptor,
-- audit row and history entry still names the same setting); their value changes from a
-- boolean to one of `WALLET`, `REVIEW` or `DELIVER` (`LATE_PAYMENT_POLICIES`). This rewrites
-- the STORED values only, with the meaning each had:
--   - true  → "WALLET": the old "on", a re-verified late approval is credited to the wallet;
--   - false → "REVIEW": the old "off", recorded as a late completion for an operator.
-- An installation that never stored one follows the registry default, which keeps the old
-- default's meaning (TonPays and TonPays Telegram WALLET; TetraPay, Rialit and the custom
-- gateway REVIEW). So nothing changes for anybody until the owner picks DELIVER.
--
-- A stored value that is neither boolean is left alone (the resolver reports it and falls back
-- to the default, as for any invalid stored value). Nothing is deleted and nobody is told
-- anything: a migration announces nothing, and no money moves here.
--
-- AUDIT: one `settings.set` row per rewritten value, written BEFORE the update with the values
-- it changes, in the pattern of 0313. The version advances and the row no longer names an
-- administrator, so the settings page does not attribute this change to whoever saved last.
INSERT INTO "audit_logs" ("id", "tenant_id", "occurred_at", "actor_type", "actor_id", "actor_label",
                          "action", "entity_type", "entity_id", "before", "after", "reason",
                          "correlation_id", "source_surface", "result")
SELECT gen_random_uuid(), sv."tenant_id", now(), 'SYSTEM_JOB', NULL,
       'migration:0322_late_payment_policy',
       'settings.set', 'Setting', sv."setting_key",
       jsonb_build_object('value', sv."value", 'source', 'TENANT'),
       jsonb_build_object('value', CASE WHEN sv."value" = 'true'::jsonb THEN 'WALLET' ELSE 'REVIEW' END,
                          'source', 'TENANT'),
       'NEXA-OWNER-BATCH-1 PR-5: the late-credit switch became a late-payment policy (true = WALLET, false = REVIEW)',
       'migration-0322-late-payment-policy', 'WORKER', 'SUCCESS'
  FROM "setting_values" sv
 WHERE sv."setting_key" IN ('payments.late_credit.tonpays_enabled',
                            'payments.late_credit.tonpays_telegram_enabled',
                            'payments.late_credit.tetrapay_enabled',
                            'payments.late_credit.rialit_enabled',
                            'payments.late_credit.custom_enabled')
   AND jsonb_typeof(sv."value") = 'boolean';
--> statement-breakpoint
UPDATE "setting_values"
   SET "value" = CASE WHEN "value" = 'true'::jsonb THEN '"WALLET"'::jsonb ELSE '"REVIEW"'::jsonb END,
       "version" = "version" + 1,
       "updated_at" = now(),
       "updated_by_admin_id" = NULL
 WHERE "setting_key" IN ('payments.late_credit.tonpays_enabled',
                         'payments.late_credit.tonpays_telegram_enabled',
                         'payments.late_credit.tetrapay_enabled',
                         'payments.late_credit.rialit_enabled',
                         'payments.late_credit.custom_enabled')
   AND jsonb_typeof("value") = 'boolean';
