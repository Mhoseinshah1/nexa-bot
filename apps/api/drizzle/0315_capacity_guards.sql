CREATE TABLE "heavy_job_tickets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"priority" integer NOT NULL,
	"enqueued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"lease_until" timestamp with time zone NOT NULL,
	CONSTRAINT "heavy_job_tickets_kind_check" CHECK (kind IN ('BACKUP', 'IMPORT', 'EXPORT', 'REPORT')),
	CONSTRAINT "heavy_job_tickets_state_check" CHECK (state IN ('QUEUED', 'RUNNING', 'DONE', 'ABANDONED')),
	CONSTRAINT "heavy_job_tickets_priority_check" CHECK (priority >= 0),
	CONSTRAINT "heavy_job_tickets_started_check" CHECK ((state = 'QUEUED') = (started_at IS NULL) OR state = 'ABANDONED')
);
--> statement-breakpoint
CREATE TABLE "tenant_capacity_limits" (
	"tenant_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"mode" text NOT NULL,
	"value" integer,
	"updated_at" timestamp with time zone NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "tenant_capacity_limits_pkey" PRIMARY KEY("tenant_id","resource"),
	CONSTRAINT "tenant_capacity_limits_resource_check" CHECK (resource IN ('UPDATE_CONCURRENCY', 'DB_CONNECTIONS', 'JOB_TURN_WEIGHT', 'BROADCAST_PER_SECOND', 'HEAVY_JOB_PRIORITY', 'NEW_CUSTOMERS_PER_MINUTE', 'SUPPORT_AI_MONTHLY_REQUESTS', 'STORAGE_MB', 'INSTALLATION_HEAVY_JOB_CONCURRENCY', 'INSTALLATION_HEAVY_JOB_MIN_FREE_MEMORY_MB', 'INSTALLATION_ALERT_MIN_FREE_MEMORY_MB', 'INSTALLATION_ALERT_WORKER_LAG_SECONDS')),
	CONSTRAINT "tenant_capacity_limits_mode_check" CHECK (mode IN ('LIMITED', 'UNLIMITED')),
	CONSTRAINT "tenant_capacity_limits_value_check" CHECK ((mode = 'UNLIMITED' AND value IS NULL) OR (mode = 'LIMITED' AND value IS NOT NULL AND value >= 0))
);
--> statement-breakpoint
ALTER TABLE "heavy_job_tickets" ADD CONSTRAINT "heavy_job_tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_capacity_limits" ADD CONSTRAINT "tenant_capacity_limits_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "heavy_job_tickets_tenant_idx" ON "heavy_job_tickets" USING btree ("tenant_id","enqueued_at");--> statement-breakpoint
CREATE INDEX "heavy_job_tickets_live_idx" ON "heavy_job_tickets" USING btree ("state","priority","enqueued_at") WHERE state IN ('QUEUED', 'RUNNING');