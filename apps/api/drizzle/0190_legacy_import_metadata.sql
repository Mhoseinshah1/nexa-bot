CREATE TABLE "legacy_import_map" (
	"tenant_id" uuid NOT NULL,
	"legacy_table" text NOT NULL,
	"legacy_id" text NOT NULL,
	"run_id" uuid NOT NULL,
	"checksum" text NOT NULL,
	"status" text NOT NULL,
	"reason_code" text,
	"entity_type" text,
	"entity_id" uuid,
	"attempts" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legacy_import_map_pk" PRIMARY KEY("tenant_id","legacy_table","legacy_id"),
	CONSTRAINT "legacy_import_map_status_check" CHECK (status IN ('IMPORTED', 'SKIPPED', 'MANUAL_REVIEW', 'FAILED')),
	CONSTRAINT "legacy_import_map_reason_check" CHECK (reason_code IS NULL OR reason_code IN ('PROVIDER_MISSING', 'AMBIGUOUS_PANEL', 'PANEL_UNMAPPED', 'USERNAME_CASE_COLLISION', 'TEST_PANEL', 'HISTORY_NOT_IMPORTED', 'EXISTING_CUSTOMER', 'NEGATIVE_BALANCE', 'INVALID_SOURCE_ROW', 'PROVIDER_READ_FAILED', 'INTERNAL_ERROR')),
	CONSTRAINT "legacy_import_map_entity_type_check" CHECK (entity_type IS NULL OR entity_type IN ('CUSTOMER', 'WALLET_ENTRY', 'SERVICE', 'ORDER', 'PANEL')),
	CONSTRAINT "legacy_import_map_table_check" CHECK (legacy_table IN ('user')),
	CONSTRAINT "legacy_import_map_legacy_key_check" CHECK (CASE legacy_table
            WHEN 'user' THEN legacy_id ~ '^[1-9][0-9]{0,19}$'
            ELSE false
          END),
	CONSTRAINT "legacy_import_map_checksum_check" CHECK (checksum ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_import_map_attempts_check" CHECK (attempts >= 1),
	CONSTRAINT "legacy_import_map_status_shape_check" CHECK (CASE status
            WHEN 'IMPORTED' THEN entity_type IS NOT NULL AND entity_id IS NOT NULL
            ELSE entity_type IS NULL AND entity_id IS NULL AND reason_code IS NOT NULL
          END)
);
--> statement-breakpoint
CREATE TABLE "legacy_import_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"source_fingerprint" text NOT NULL,
	"code_version" text,
	"failure_code" text,
	"rows_seen" integer DEFAULT 0 NOT NULL,
	"rows_imported" integer DEFAULT 0 NOT NULL,
	"rows_skipped" integer DEFAULT 0 NOT NULL,
	"rows_manual_review" integer DEFAULT 0 NOT NULL,
	"rows_failed" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_progress_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "legacy_import_runs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "legacy_import_runs_mode_check" CHECK (mode IN ('DRY_RUN', 'APPLY')),
	CONSTRAINT "legacy_import_runs_status_check" CHECK (status IN ('RUNNING', 'COMPLETED', 'FAILED', 'ABORTED')),
	CONSTRAINT "legacy_import_runs_failure_code_check" CHECK (failure_code IS NULL OR failure_code IN ('SOURCE_UNREADABLE', 'SOURCE_FINGERPRINT_MISMATCH', 'PROVIDER_UNAVAILABLE', 'INTERNAL_ERROR')),
	CONSTRAINT "legacy_import_runs_fingerprint_check" CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "legacy_import_runs_code_version_check" CHECK (code_version IS NULL OR code_version ~ '^[A-Za-z0-9._+-]{1,64}$'),
	CONSTRAINT "legacy_import_runs_counters_check" CHECK (rows_seen >= 0 AND rows_imported >= 0 AND rows_skipped >= 0 AND rows_manual_review >= 0 AND rows_failed >= 0),
	CONSTRAINT "legacy_import_runs_status_stamps_check" CHECK (CASE status
            WHEN 'RUNNING' THEN finished_at IS NULL AND failure_code IS NULL
            WHEN 'FAILED' THEN finished_at IS NOT NULL AND failure_code IS NOT NULL
            ELSE finished_at IS NOT NULL AND failure_code IS NULL
          END),
	CONSTRAINT "legacy_import_runs_window_check" CHECK (finished_at IS NULL OR finished_at >= started_at),
	CONSTRAINT "legacy_import_runs_finish_after_progress_check" CHECK (finished_at IS NULL OR finished_at >= last_progress_at)
);
--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_map" ADD CONSTRAINT "legacy_import_map_run_fk" FOREIGN KEY ("tenant_id","run_id") REFERENCES "public"."legacy_import_runs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legacy_import_runs" ADD CONSTRAINT "legacy_import_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legacy_import_map_tenant_run_idx" ON "legacy_import_map" USING btree ("tenant_id","run_id","status");--> statement-breakpoint
CREATE INDEX "legacy_import_map_tenant_status_idx" ON "legacy_import_map" USING btree ("tenant_id","status","legacy_table","legacy_id");--> statement-breakpoint
CREATE INDEX "legacy_import_map_tenant_entity_idx" ON "legacy_import_map" USING btree ("tenant_id","entity_type","entity_id") WHERE entity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "legacy_import_runs_tenant_started_idx" ON "legacy_import_runs" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "legacy_import_runs_one_running_idx" ON "legacy_import_runs" USING btree ("tenant_id") WHERE status = 'RUNNING';