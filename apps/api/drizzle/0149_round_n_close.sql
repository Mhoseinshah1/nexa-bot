CREATE TABLE "frozen_audience_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"frozen_audience_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_id" uuid,
	"bot_instance_id" uuid,
	"chat_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "frozen_audiences" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"definition" jsonb NOT NULL,
	"definition_hash" text NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"member_count" integer NOT NULL,
	"fingerprint" text NOT NULL,
	"created_by_admin_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"released_at" timestamp with time zone,
	CONSTRAINT "frozen_audiences_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "frozen_audiences_kind_check" CHECK (kind IN ('CUSTOMERS', 'SERVICES')),
	CONSTRAINT "frozen_audiences_hash_check" CHECK (definition_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "frozen_audiences_fingerprint_check" CHECK (fingerprint ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "frozen_audiences_count_check" CHECK (member_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "broadcasts" DROP CONSTRAINT "broadcasts_content_kind_check";--> statement-breakpoint
ALTER TABLE "bulk_operations" DROP CONSTRAINT "bulk_operations_state_check";--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN "sent_message_id" bigint;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN "pin_state" text;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN "pin_error_code" text;--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD COLUMN "pin_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "purpose" text DEFAULT 'MARKETING' NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "source_chat_id" text;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "source_message_id" bigint;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "source_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "pin" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD COLUMN "frozen_audience_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD COLUMN "frozen_audience_id" uuid;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD COLUMN "paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD COLUMN "frozen_audience_id" uuid;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "marketing_opt_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "frozen_audience_members" ADD CONSTRAINT "frozen_audience_members_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audience_members" ADD CONSTRAINT "frozen_audience_members_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audience_members" ADD CONSTRAINT "frozen_audience_members_audience_fk" FOREIGN KEY ("tenant_id","frozen_audience_id") REFERENCES "public"."frozen_audiences"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audience_members" ADD CONSTRAINT "frozen_audience_members_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audience_members" ADD CONSTRAINT "frozen_audience_members_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audiences" ADD CONSTRAINT "frozen_audiences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "frozen_audiences" ADD CONSTRAINT "frozen_audiences_created_by_admin_id_admins_id_fk" FOREIGN KEY ("created_by_admin_id") REFERENCES "public"."admins"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "frozen_audience_members_customer_key" ON "frozen_audience_members" USING btree ("tenant_id","frozen_audience_id","customer_id") WHERE service_id IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "frozen_audience_members_service_key" ON "frozen_audience_members" USING btree ("tenant_id","frozen_audience_id","service_id") WHERE service_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "frozen_audiences_held_idx" ON "frozen_audiences" USING btree ("tenant_id","created_at") WHERE released_at IS NULL;--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_frozen_audience_fk" FOREIGN KEY ("tenant_id","frozen_audience_id") REFERENCES "public"."frozen_audiences"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_frozen_audience_fk" FOREIGN KEY ("tenant_id","frozen_audience_id") REFERENCES "public"."frozen_audiences"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_frozen_audience_fk" FOREIGN KEY ("tenant_id","frozen_audience_id") REFERENCES "public"."frozen_audiences"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "broadcast_recipients_pin_stranded_idx" ON "broadcast_recipients" USING btree ("pin_started_at") WHERE pin_state = 'PENDING';--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_pin_state_check" CHECK (pin_state IS NULL OR pin_state IN ('PENDING', 'PINNED', 'FAILED', 'UNCONFIRMED'));--> statement-breakpoint
ALTER TABLE "broadcast_recipients" ADD CONSTRAINT "broadcast_recipients_pin_check" CHECK ((pin_state IS NULL OR (state = 'SENT' AND sent_message_id IS NOT NULL AND pin_started_at IS NOT NULL))
          AND (pin_error_code IS NULL OR length(pin_error_code) BETWEEN 1 AND 100));--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_purpose_check" CHECK (purpose IN ('MARKETING', 'SERVICE_ANNOUNCEMENT'));--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_source_check" CHECK ((content_kind IN ('FORWARD', 'COPY')) = (source_chat_id IS NOT NULL AND source_message_id IS NOT NULL)
          AND (source_message_id IS NULL OR source_message_id > 0)
          AND (source_verified_at IS NULL OR source_chat_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "broadcasts" ADD CONSTRAINT "broadcasts_content_kind_check" CHECK (content_kind IN ('TEXT', 'PHOTO', 'VIDEO', 'DOCUMENT', 'FORWARD', 'COPY'));--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_paused_check" CHECK ((state = 'PAUSED') = (paused_at IS NOT NULL));--> statement-breakpoint
ALTER TABLE "bulk_operations" ADD CONSTRAINT "bulk_operations_state_check" CHECK (state IN ('RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED'));--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_frozen_kind_check" CHECK (frozen_audience_id IS NULL OR kind IN ('WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT', 'ANNOUNCEMENT'));