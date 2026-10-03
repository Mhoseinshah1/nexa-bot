CREATE TABLE "admin_notification_reads" (
	"tenant_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"read_through" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "admin_notification_reads_pk" PRIMARY KEY("tenant_id","admin_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "admin_notification_reads" ADD CONSTRAINT "admin_notification_reads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notification_reads" ADD CONSTRAINT "admin_notification_reads_event_id_operational_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."operational_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_notification_reads" ADD CONSTRAINT "admin_notification_reads_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;