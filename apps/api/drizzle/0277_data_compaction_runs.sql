CREATE TABLE "data_compaction_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"cutoffs" jsonb NOT NULL,
	"counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stop_reason" text,
	CONSTRAINT "data_compaction_runs_trigger_check" CHECK (trigger IN ('WORKER', 'CLI')),
	CONSTRAINT "data_compaction_runs_mode_check" CHECK (mode IN ('DRY_RUN', 'APPLY')),
	CONSTRAINT "data_compaction_runs_state_check" CHECK (state IN ('RUNNING', 'COMPLETED', 'STOPPED', 'FAILED')),
	CONSTRAINT "data_compaction_runs_stop_reason_check" CHECK (stop_reason IS NULL OR stop_reason IN ('RECOVERY_IN_FLIGHT', 'BACKUP_IN_FLIGHT', 'SCOPE_INACTIVE', 'BATCH_CEILING', 'ABANDONED', 'ERROR')),
	CONSTRAINT "data_compaction_runs_finished_check" CHECK ((state = 'RUNNING') = (finished_at IS NULL)),
	CONSTRAINT "data_compaction_runs_counts_check" CHECK (jsonb_typeof(counts) = 'object' AND jsonb_typeof(cutoffs) = 'object')
);
--> statement-breakpoint
ALTER TABLE "data_compaction_runs" ADD CONSTRAINT "data_compaction_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "data_compaction_runs_one_running_idx" ON "data_compaction_runs" USING btree ("tenant_id") WHERE state = 'RUNNING';--> statement-breakpoint
CREATE INDEX "data_compaction_runs_tenant_started_idx" ON "data_compaction_runs" USING btree ("tenant_id","started_at");