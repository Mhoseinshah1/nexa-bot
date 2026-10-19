CREATE TABLE "customer_notification_rate_windows" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"minute_started_at" timestamp with time zone NOT NULL,
	"minute_claimed" integer NOT NULL,
	"hour_started_at" timestamp with time zone NOT NULL,
	"hour_fresh" integer NOT NULL,
	"burst_open" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "customer_notification_rate_windows_counts_check" CHECK (minute_claimed >= 0 AND hour_fresh >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_reminder_baselines" (
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"baseline_at" timestamp with time zone NOT NULL,
	"basis_expires_at" timestamp with time zone,
	"basis_traffic_limit_bytes" bigint NOT NULL,
	"used_bytes" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_reminder_baselines_pk" PRIMARY KEY("tenant_id","service_id"),
	CONSTRAINT "service_reminder_baselines_figures_check" CHECK ("service_reminder_baselines"."basis_traffic_limit_bytes" >= 0 AND ("service_reminder_baselines"."used_bytes" IS NULL OR "service_reminder_baselines"."used_bytes" >= 0))
);
--> statement-breakpoint
ALTER TABLE "customer_notification_rate_windows" ADD CONSTRAINT "customer_notification_rate_windows_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reminder_baselines" ADD CONSTRAINT "service_reminder_baselines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_reminder_baselines" ADD CONSTRAINT "service_reminder_baselines_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;