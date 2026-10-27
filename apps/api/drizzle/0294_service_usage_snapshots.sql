CREATE TABLE "service_usage_snapshots" (
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"bucket_at" timestamp with time zone NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"used_bytes" bigint NOT NULL,
	"total_bytes" bigint,
	"expires_at" timestamp with time zone,
	CONSTRAINT "service_usage_snapshots_pk" PRIMARY KEY("tenant_id","service_id","bucket_at"),
	CONSTRAINT "service_usage_snapshots_figures_check" CHECK ("service_usage_snapshots"."used_bytes" >= 0 AND ("service_usage_snapshots"."total_bytes" IS NULL OR "service_usage_snapshots"."total_bytes" > 0))
);
--> statement-breakpoint
ALTER TABLE "service_usage_snapshots" ADD CONSTRAINT "service_usage_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_usage_snapshots" ADD CONSTRAINT "service_usage_snapshots_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_usage_snapshots_taken_idx" ON "service_usage_snapshots" USING btree ("tenant_id","taken_at");