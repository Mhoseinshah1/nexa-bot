CREATE TABLE "tenant_restores" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"hosted_tenant_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"stage" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"archive_id" text,
	"dry_run" jsonb,
	"requested_by_admin_id" uuid NOT NULL,
	"confirmed_at" timestamp with time zone,
	"pre_replace_run_id" uuid,
	"failure_code" text,
	"failure_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "tenant_restores_mode_check" CHECK (mode IN ('NEW', 'REPLACE')),
	CONSTRAINT "tenant_restores_state_check" CHECK (state IN ('REQUESTED', 'VERIFYING', 'VERIFIED', 'APPLYING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "tenant_restores_stage_check" CHECK (stage IN ('OPEN', 'SCHEMA', 'SCRATCH_LOAD', 'SCRATCH_VERIFY', 'MIGRATE_SCRATCH', 'PREFLIGHT', 'APPLY', 'DONE')),
	CONSTRAINT "tenant_restores_sha_check" CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_restores_not_self_check" CHECK (tenant_id <> hosted_tenant_id),
	CONSTRAINT "tenant_restores_finished_check" CHECK ((state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)),
	CONSTRAINT "tenant_restores_failure_check" CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "backup_runs" DROP CONSTRAINT "backup_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "heavy_job_tickets" DROP CONSTRAINT "heavy_job_tickets_kind_check";--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "archive_scope" text DEFAULT 'INSTALLATION' NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "subject_tenant_id" uuid;--> statement-breakpoint
ALTER TABLE "tenant_restores" ADD CONSTRAINT "tenant_restores_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_restores" ADD CONSTRAINT "tenant_restores_pre_replace_run_id_backup_runs_id_fk" FOREIGN KEY ("pre_replace_run_id") REFERENCES "public"."backup_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_restores" ADD CONSTRAINT "tenant_restores_requested_by_fk" FOREIGN KEY ("tenant_id","requested_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_restores_single_active_idx" ON "tenant_restores" USING btree ("tenant_id") WHERE state IN ('REQUESTED', 'VERIFYING', 'VERIFIED', 'APPLYING');--> statement-breakpoint
CREATE INDEX "tenant_restores_tenant_created_idx" ON "tenant_restores" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_subject_tenant_id_tenants_id_fk" FOREIGN KEY ("subject_tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "backup_runs_subject_tenant_idx" ON "backup_runs" USING btree ("subject_tenant_id","started_at") WHERE subject_tenant_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_archive_scope_check" CHECK (archive_scope IN ('INSTALLATION', 'TENANT'));--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_subject_tenant_check" CHECK ((archive_scope = 'TENANT') = (subject_tenant_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_trigger_check" CHECK (trigger IN ('MANUAL', 'SCHEDULED', 'PRE_RESTORE', 'PRE_REPLACE', 'MOVE'));--> statement-breakpoint
ALTER TABLE "heavy_job_tickets" ADD CONSTRAINT "heavy_job_tickets_kind_check" CHECK (kind IN ('BACKUP', 'IMPORT', 'EXPORT', 'REPORT', 'RESTORE'));