-- Round 5C-2 group A: the baselines the R5A-2 backfill wrote with a figure.
--
-- The backfill (`ServiceReminderService.reconcileImportedBaselines`) used to record the usage
-- figure ON THE ROW as the baseline whenever the service had ever been measured. For an
-- installation imported weeks earlier that figure is the import's, so the first SYNC_USAGE after
-- the takeover read as a crossing of 80 / 90 / 100 % and was announced (38 notices in 20
-- minutes on the test server). The code now writes the backfill baseline WITHOUT a figure: the
-- first figure `recordUsage` records is the baseline, silent, every threshold it has reached
-- marked as passed.
--
-- This migration makes the rows the old backfill already wrote follow the same rule: such a
-- baseline's figure is set to NULL, so the service's next sync is its first (silent) one. The
-- direction is always the quiet one - a NULL figure can only suppress a notice, never raise one.
-- The queued notices themselves are moved to SUPERSEDED by the existing reconcile
-- (`supersedeImportedUsageNotices`, one audit row per batch) when the worker starts, which is
-- exactly the set of PENDING usage notices whose service now has a baseline without a figure;
-- the dispatcher's send-time precondition refuses the same rows in the meantime.
--
-- WHICH rows: a baseline written in one instant (`created_at = baseline_at`, as the backfill and
-- the import seed both do) with a figure, in a tenant that has a backfill audit row recorded at
-- that instant (the batch audit row is written in the batch's own transaction; ten minutes is
-- far more than one batch). An import seed that happens to fall in the same window is reset too,
-- which is harmless: its service's first sync becomes the silent baseline.
--
-- AUDIT: one `audit_logs` row per tenant, written BEFORE the update with the count it will
-- change, in the pattern of 0155. Nothing else is read or written: no notification, no
-- reminder row, no ledger entry, no service.
INSERT INTO "audit_logs" ("id", "tenant_id", "occurred_at", "actor_type", "actor_id", "actor_label",
                          "action", "entity_type", "entity_id", "before", "after", "reason",
                          "correlation_id", "source_surface", "result")
SELECT gen_random_uuid(), x."tenant_id", now(), 'SYSTEM_JOB', NULL,
       'migration:0272_backfill_baselines_unmeasured',
       'service_reminder.backfill_baselines_reset_to_unmeasured', 'Service', NULL,
       jsonb_build_object('baselinesWithFigure', x."n"),
       jsonb_build_object('baselinesWithFigure', 0),
       'the R5A-2 backfill recorded a stale pre-takeover figure as the baseline; the first sync after the takeover must be the silent one',
       'migration-0272-backfill-baselines-unmeasured', 'WORKER', 'SUCCESS'
  FROM (
    SELECT b."tenant_id", count(*) AS n
      FROM "service_reminder_baselines" b
     WHERE b."used_bytes" IS NOT NULL
       AND b."created_at" = b."baseline_at"
       AND EXISTS (
         SELECT 1 FROM "audit_logs" a
          WHERE a."tenant_id" = b."tenant_id"
            AND a."action" = 'service_reminder.imported_baselines_backfilled'
            AND a."occurred_at" BETWEEN b."created_at" - interval '1 minute'
                                    AND b."created_at" + interval '10 minutes'
       )
     GROUP BY b."tenant_id"
  ) x;
--> statement-breakpoint
UPDATE "service_reminder_baselines" b
   SET "used_bytes" = NULL
 WHERE b."used_bytes" IS NOT NULL
   AND b."created_at" = b."baseline_at"
   AND EXISTS (
     SELECT 1 FROM "audit_logs" a
      WHERE a."tenant_id" = b."tenant_id"
        AND a."action" = 'service_reminder.imported_baselines_backfilled'
        AND a."occurred_at" BETWEEN b."created_at" - interval '1 minute'
                                AND b."created_at" + interval '10 minutes'
   );
