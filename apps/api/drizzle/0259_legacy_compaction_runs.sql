CREATE TABLE "legacy_compaction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"requested_by_admin_id" uuid,
	"requested_by_label" text,
	"updated_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_heartbeat_at" timestamp with time zone,
	"archive_backup_id" uuid,
	"cursor" uuid,
	"deleted" bigint DEFAULT 0 NOT NULL,
	"deduplicated" bigint DEFAULT 0 NOT NULL,
	"stripped" bigint DEFAULT 0 NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"failure_code" text,
	"finished_at" timestamp with time zone,
	CONSTRAINT "legacy_compaction_runs_state_check" CHECK (state IN ('REQUESTED', 'ARCHIVING', 'MEASURING', 'DROPPING', 'DEDUPING', 'STRIPPING', 'VACUUMING', 'COMPLETED', 'FAILED')),
	CONSTRAINT "legacy_compaction_runs_failure_code_check" CHECK (failure_code IN ('legacy_compaction.archive_failed', 'legacy_compaction.archive_not_delivered', 'legacy_compaction.import_not_completed', 'legacy_compaction.step_failed')),
	CONSTRAINT "legacy_compaction_runs_finished_check" CHECK ((state IN ('COMPLETED', 'FAILED')) = (finished_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "legacy_compaction_runs" ADD CONSTRAINT "legacy_compaction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_compaction_runs" ADD CONSTRAINT "legacy_compaction_runs_requested_by_admin_id_admins_id_fk" FOREIGN KEY ("requested_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_compaction_runs_one_active_idx" ON "legacy_compaction_runs" USING btree ("tenant_id") WHERE state NOT IN ('COMPLETED', 'FAILED');--> statement-breakpoint
CREATE INDEX "legacy_compaction_runs_tenant_requested_idx" ON "legacy_compaction_runs" USING btree ("tenant_id","requested_at");