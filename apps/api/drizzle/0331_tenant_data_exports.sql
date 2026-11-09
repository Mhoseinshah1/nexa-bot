CREATE TABLE "tenant_data_exports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"state" text NOT NULL,
	"requested_by_admin_id" uuid NOT NULL,
	"requested_by_host" boolean NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"heartbeat_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"file_name" text,
	"bytes" bigint,
	"sha256" text,
	"ready_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"removed_at" timestamp with time zone,
	"failure_code" text,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tenant_data_exports_state_check" CHECK (state IN ('REQUESTED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED')),
	CONSTRAINT "tenant_data_exports_sha_check" CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "tenant_data_exports_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "tenant_data_exports_ready_check" CHECK ((state IN ('READY', 'EXPIRED')) = (file_name IS NOT NULL AND sha256 IS NOT NULL AND expires_at IS NOT NULL AND ready_at IS NOT NULL)),
	CONSTRAINT "tenant_data_exports_failure_check" CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "tenant_data_exports" ADD CONSTRAINT "tenant_data_exports_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_data_exports_single_active_idx" ON "tenant_data_exports" USING btree ("tenant_id") WHERE state IN ('REQUESTED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "tenant_data_exports_tenant_requested_idx" ON "tenant_data_exports" USING btree ("tenant_id","requested_at");--> statement-breakpoint
CREATE INDEX "tenant_data_exports_queue_idx" ON "tenant_data_exports" USING btree ("state","requested_at") WHERE state IN ('REQUESTED', 'RUNNING');--> statement-breakpoint
CREATE INDEX "tenant_data_exports_expiry_idx" ON "tenant_data_exports" USING btree ("expires_at") WHERE state = 'READY';