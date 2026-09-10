CREATE TABLE "recovery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"source" text NOT NULL,
	"state" text NOT NULL,
	"stage" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"requested_by_admin_id" uuid,
	"requested_by_label" text,
	"correlation_id" text,
	"lease_owner" text,
	"lease_heartbeat_at" timestamp with time zone,
	"workspace_path" text,
	"upload_bytes" bigint,
	"upload_sha256" text,
	"client_filename" text,
	"backup_id" uuid,
	"artifact_checksum" text,
	"archive_key_id" text,
	"verified_at" timestamp with time zone,
	"verification" jsonb,
	"restore_test" jsonb,
	"confirmed_at" timestamp with time zone,
	"confirmed_by_admin_id" uuid,
	"confirmed_session_id" uuid,
	"confirmed_checksum" text,
	"confirmation_expires_at" timestamp with time zone,
	"pre_restore_backup_id" uuid,
	"candidate_database" text,
	"displaced_database" text,
	"cutover_at" timestamp with time zone,
	"failure_code" text,
	CONSTRAINT "recovery_requests_source_check" CHECK (source IN ('UPLOAD', 'LOCAL_RUN')),
	CONSTRAINT "recovery_requests_state_check" CHECK (state IN ('UPLOADED', 'VERIFYING', 'VERIFIED', 'RESTORE_TESTING', 'RESTORE_TEST_PASSED', 'RESTORE_REQUESTED', 'PRE_RESTORE_BACKUP', 'QUIESCING', 'RESTORING', 'VALIDATING', 'CUTTING_OVER', 'RESTARTING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "recovery_requests_stage_check" CHECK (stage IN ('RECEIVE_UPLOAD', 'PARSE_CONTAINER', 'DECRYPT', 'CHECKSUM', 'MANIFEST', 'SCRATCH_RESTORE', 'SCRATCH_INSPECT', 'AWAIT_CONFIRMATION', 'EMERGENCY_BACKUP', 'QUIESCE', 'CREATE_CANDIDATE', 'RESTORE_CANDIDATE', 'MIGRATE_CANDIDATE', 'VALIDATE_CANDIDATE', 'CUTOVER', 'READINESS', 'CLEANUP', 'DONE')),
	CONSTRAINT "recovery_requests_failure_code_check" CHECK (failure_code IS NULL OR failure_code IN ('recovery.upload_rejected', 'recovery.archive_malformed', 'recovery.archive_auth_failed', 'recovery.archive_foreign_key', 'recovery.checksum_mismatch', 'recovery.manifest_invalid', 'recovery.restore_test_failed', 'recovery.restored_database_empty', 'recovery.migration_state_unreadable', 'recovery.migration_incompatible', 'recovery.confirmation_invalid', 'recovery.emergency_backup_failed', 'recovery.emergency_backup_busy', 'recovery.quiesce_failed', 'recovery.candidate_create_failed', 'recovery.candidate_restore_failed', 'recovery.candidate_validation_failed', 'recovery.cutover_failed', 'recovery.readiness_failed', 'recovery.lease_expired', 'recovery.internal')),
	CONSTRAINT "recovery_requests_finished_at_check" CHECK ((state IN ('SUCCEEDED', 'FAILED')) = (finished_at IS NOT NULL)),
	CONSTRAINT "recovery_requests_cutover_check" CHECK ((cutover_at IS NULL) = (displaced_database IS NULL)),
	CONSTRAINT "recovery_requests_confirmation_check" CHECK (num_nonnulls(confirmed_at, confirmed_by_admin_id, confirmed_checksum, confirmation_expires_at) IN (0, 4))
);
--> statement-breakpoint
ALTER TABLE "backup_runs" DROP CONSTRAINT "backup_runs_trigger_check";--> statement-breakpoint
ALTER TABLE "recovery_requests" ADD CONSTRAINT "recovery_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_requests_single_destructive_idx" ON "recovery_requests" USING btree ((true)) WHERE state IN ('RESTORE_REQUESTED', 'PRE_RESTORE_BACKUP', 'QUIESCING', 'RESTORING', 'VALIDATING', 'CUTTING_OVER', 'RESTARTING');--> statement-breakpoint
CREATE INDEX "recovery_requests_tenant_created_idx" ON "recovery_requests" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_trigger_check" CHECK (trigger IN ('MANUAL', 'SCHEDULED', 'PRE_RESTORE'));