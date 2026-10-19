CREATE TABLE "customer_reminder_raise_counters" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"raised_total" bigint NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "customer_reminder_raise_counters_total_check" CHECK (raised_total >= 0)
);
--> statement-breakpoint
ALTER TABLE "customer_notification_rate_windows" DROP CONSTRAINT "customer_notification_rate_windows_counts_check";--> statement-breakpoint
ALTER TABLE "customer_notification_rate_windows" ADD COLUMN "raised_seen" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_reminder_raise_counters" ADD CONSTRAINT "customer_reminder_raise_counters_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notification_rate_windows" ADD CONSTRAINT "customer_notification_rate_windows_counts_check" CHECK (minute_claimed >= 0 AND hour_fresh >= 0 AND raised_seen >= 0);