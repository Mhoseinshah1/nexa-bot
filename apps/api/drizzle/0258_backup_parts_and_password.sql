CREATE TABLE "backup_archive_passwords" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"password_ciphertext" text NOT NULL,
	"password_key_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"created_by_admin_id" uuid,
	"superseded_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_run_parts" (
	"backup_id" uuid NOT NULL,
	"part_number" integer NOT NULL,
	"filename" text NOT NULL,
	"range_start" bigint NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"delivery_state" text NOT NULL,
	"delivery_attempted_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"delivery_detail" text,
	CONSTRAINT "backup_run_parts_backup_id_part_number_pk" PRIMARY KEY("backup_id","part_number"),
	CONSTRAINT "backup_run_parts_delivery_state_check" CHECK (delivery_state IN ('NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED_DEFINITIVE', 'OUTCOME_UNKNOWN')),
	CONSTRAINT "backup_run_parts_part_number_check" CHECK (part_number > 0),
	CONSTRAINT "backup_run_parts_bytes_check" CHECK (bytes >= 0 AND range_start >= 0),
	CONSTRAINT "backup_run_parts_message_id_check" CHECK (telegram_message_id IS NULL OR delivery_state = 'SUCCEEDED')
);
--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "archive_format" text;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "part_count" integer;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "archive_seal_id" uuid;--> statement-breakpoint
ALTER TABLE "backup_runs" ADD COLUMN "summary_delivery_state" text;--> statement-breakpoint
ALTER TABLE "backup_archive_passwords" ADD CONSTRAINT "backup_archive_passwords_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_archive_passwords" ADD CONSTRAINT "backup_archive_passwords_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_run_parts" ADD CONSTRAINT "backup_run_parts_backup_id_backup_runs_id_fk" FOREIGN KEY ("backup_id") REFERENCES "public"."backup_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "backup_archive_passwords_current_idx" ON "backup_archive_passwords" USING btree ("tenant_id") WHERE superseded_at IS NULL;--> statement-breakpoint
CREATE INDEX "backup_archive_passwords_tenant_created_idx" ON "backup_archive_passwords" USING btree ("tenant_id","created_at");--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_archive_format_check" CHECK (archive_format IN ('NXB', 'SEVEN_ZIP'));--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_summary_delivery_state_check" CHECK (summary_delivery_state IN ('NOT_ATTEMPTED', 'SUCCEEDED', 'FAILED_DEFINITIVE', 'OUTCOME_UNKNOWN'));--> statement-breakpoint
ALTER TABLE "backup_runs" ADD CONSTRAINT "backup_runs_part_count_check" CHECK (part_count IS NULL OR part_count > 0);