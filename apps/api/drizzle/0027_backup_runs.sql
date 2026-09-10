CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"trigger" text NOT NULL,
	"state" text NOT NULL,
	"stage" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"lease_owner" text NOT NULL,
	"lease_heartbeat_at" timestamp with time zone NOT NULL,
	"dump_bytes" bigint,
	"archive_bytes" bigint,
	"checksum" text,
	"verified_at" timestamp with time zone,
	"delivery_state" text NOT NULL,
	"delivery_attempted_at" timestamp with time zone,
	"delivery_detail" text,
	"failure_code" text,
	"failure_message" text,
	"cleanup_ok" boolean NOT NULL,
	"cleanup_detail" text,
	CONSTRAINT "backup_runs_trigger_check" CHECK (trigger IN ('MANUAL', 'SCHEDULED')),
	CONSTRAINT "backup_runs_state_check" CHECK (state IN ('RUNNING', 'SUCCEEDED', 'FAILED')),
	CONSTRAINT "backup_runs_stage_check" CHECK (stage IN ('DUMP', 'CHECKSUM', 'ENCRYPT', 'VERIFY_RESTORE', 'DELIVER', 'CLEANUP')),
	CONSTRAINT "backup_runs_delivery_state_check" CHECK (delivery_state IN ('NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED_DEFINITIVE', 'OUTCOME_UNKNOWN')),
	CONSTRAINT "backup_runs_finished_at_check" CHECK ((state = 'RUNNING') = (finished_at IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "backup_runs_single_active_idx" ON "backup_runs" USING btree ((true)) WHERE state = 'RUNNING';--> statement-breakpoint
CREATE INDEX "backup_runs_started_at_idx" ON "backup_runs" USING btree ("started_at");