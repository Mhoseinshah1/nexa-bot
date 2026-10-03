CREATE TABLE "incident_communications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"message" text NOT NULL,
	"recipients" integer NOT NULL,
	"sent_by_admin_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incident_communications_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incident_communications_recipients_check" CHECK (recipients >= 0)
);
--> statement-breakpoint
CREATE TABLE "incident_effects" (
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"target_kind" text NOT NULL,
	"target_ref" text NOT NULL,
	"subject_ref" text NOT NULL,
	"state" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incident_effects_pk" PRIMARY KEY("tenant_id","incident_id","kind","subject_ref"),
	CONSTRAINT "incident_effects_kind_check" CHECK (kind IN ('PANEL_DRAIN', 'LOCATION_DISABLE', 'PRODUCT_DEACTIVATE', 'GATEWAY_DISABLE')),
	CONSTRAINT "incident_effects_target_kind_check" CHECK (target_kind IN ('PANEL', 'LOCATION', 'PRODUCT', 'GATEWAY')),
	CONSTRAINT "incident_effects_state_check" CHECK (state IN ('PENDING', 'APPLIED', 'ALREADY', 'FAILED', 'REVERTING', 'REVERTED', 'KEPT'))
);
--> statement-breakpoint
CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"actor_label" text,
	"detail" jsonb,
	"occurred_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incident_events_kind_check" CHECK (kind IN ('CREATED', 'SCHEDULED', 'STARTED', 'UPDATED', 'SCOPE_CHANGED', 'EFFECT', 'EFFECTS_PENDING', 'COMMUNICATED', 'RESOLVED', 'CANCELLED')),
	CONSTRAINT "incident_events_actor_type_check" CHECK (actor_type IN ('CUSTOMER', 'TELEGRAM_ADMIN', 'WEB_ADMIN', 'SYSTEM_JOB', 'API', 'PROVIDER_SYNC'))
);
--> statement-breakpoint
CREATE TABLE "incident_notices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"communication_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incident_notices_customer_key" UNIQUE("tenant_id","communication_id","customer_id")
);
--> statement-breakpoint
CREATE TABLE "incident_targets" (
	"tenant_id" uuid NOT NULL,
	"incident_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	CONSTRAINT "incident_targets_pk" PRIMARY KEY("tenant_id","incident_id","kind","ref"),
	CONSTRAINT "incident_targets_kind_check" CHECK (kind IN ('PANEL', 'LOCATION', 'PRODUCT', 'GATEWAY'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"status" text NOT NULL,
	"title" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"customer_message" text,
	"stop_sales" boolean DEFAULT false NOT NULL,
	"admin_banner" boolean DEFAULT true NOT NULL,
	"scheduled_start_at" timestamp with time zone,
	"scheduled_end_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "incidents_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "incidents_kind_check" CHECK (kind IN ('INCIDENT', 'MAINTENANCE')),
	CONSTRAINT "incidents_severity_check" CHECK (severity IN ('MINOR', 'MAJOR', 'CRITICAL')),
	CONSTRAINT "incidents_status_check" CHECK (status IN ('SCHEDULED', 'ACTIVE', 'RESOLVED', 'CANCELLED')),
	CONSTRAINT "incidents_title_check" CHECK (length(btrim(title)) BETWEEN 1 AND 160),
	CONSTRAINT "incidents_message_check" CHECK (customer_message IS NULL OR length(customer_message) BETWEEN 1 AND 1500),
	CONSTRAINT "incidents_version_check" CHECK (version >= 1),
	CONSTRAINT "incidents_status_stamps_check" CHECK (CASE status
            WHEN 'SCHEDULED' THEN scheduled_start_at IS NOT NULL AND started_at IS NULL AND resolved_at IS NULL
            WHEN 'ACTIVE' THEN started_at IS NOT NULL AND resolved_at IS NULL
            WHEN 'RESOLVED' THEN started_at IS NOT NULL AND resolved_at IS NOT NULL
            WHEN 'CANCELLED' THEN started_at IS NULL AND resolved_at IS NOT NULL
          END),
	CONSTRAINT "incidents_window_check" CHECK (scheduled_end_at IS NULL OR scheduled_start_at IS NULL OR scheduled_end_at > scheduled_start_at)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "incident_communications" ADD CONSTRAINT "incident_communications_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_communications" ADD CONSTRAINT "incident_communications_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_effects" ADD CONSTRAINT "incident_effects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_effects" ADD CONSTRAINT "incident_effects_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notices" ADD CONSTRAINT "incident_notices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notices" ADD CONSTRAINT "incident_notices_communication_fk" FOREIGN KEY ("tenant_id","communication_id") REFERENCES "public"."incident_communications"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_notices" ADD CONSTRAINT "incident_notices_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_targets" ADD CONSTRAINT "incident_targets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_targets" ADD CONSTRAINT "incident_targets_incident_fk" FOREIGN KEY ("tenant_id","incident_id") REFERENCES "public"."incidents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_created_by_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "incident_events_incident_idx" ON "incident_events" USING btree ("tenant_id","incident_id","occurred_at","id");--> statement-breakpoint
CREATE INDEX "incidents_tenant_status_idx" ON "incidents" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "incidents_scheduled_idx" ON "incidents" USING btree ("scheduled_start_at") WHERE status = 'SCHEDULED';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE'));