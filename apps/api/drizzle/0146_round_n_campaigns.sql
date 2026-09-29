CREATE TABLE "campaign_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"config" jsonb NOT NULL,
	"discount_id" uuid,
	"cashback_rule_id" uuid,
	"failure_code" text,
	"launched_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaign_actions_kind_check" CHECK (kind IN ('DISCOUNT', 'CASHBACK', 'WALLET_GIFT', 'TRAFFIC_GIFT', 'TIME_GIFT', 'ANNOUNCEMENT')),
	CONSTRAINT "campaign_actions_state_check" CHECK (state IN ('PENDING', 'LAUNCHED', 'CANCELLED', 'FAILED')),
	CONSTRAINT "campaign_actions_discount_kind_check" CHECK (discount_id IS NULL OR kind = 'DISCOUNT'),
	CONSTRAINT "campaign_actions_cashback_kind_check" CHECK (cashback_rule_id IS NULL OR kind = 'CASHBACK'),
	CONSTRAINT "campaign_actions_launched_check" CHECK ((state = 'LAUNCHED') = (launched_at IS NOT NULL)),
	CONSTRAINT "campaign_actions_failed_check" CHECK ((state = 'FAILED') = (failure_code IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'DRAFT' NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"audience" jsonb NOT NULL,
	"audience_hash" text NOT NULL,
	"audience_frozen_at" timestamp with time zone,
	"audience_confirmed_count" integer,
	"audience_fingerprint" text,
	"created_by_admin_id" uuid,
	"scheduled_by_admin_id" uuid,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"cancelled_by_admin_id" uuid,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "campaigns_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "campaigns_state_check" CHECK (state IN ('DRAFT', 'SCHEDULED', 'ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED')),
	CONSTRAINT "campaigns_window_check" CHECK (starts_at < ends_at),
	CONSTRAINT "campaigns_name_check" CHECK (char_length(name) BETWEEN 1 AND 80),
	CONSTRAINT "campaigns_description_check" CHECK (char_length(description) <= 2000),
	CONSTRAINT "campaigns_frozen_check" CHECK ((audience_frozen_at IS NULL) = (scheduled_at IS NULL) AND (scheduled_at IS NULL) = (audience_confirmed_count IS NULL) AND (scheduled_at IS NULL) = (audience_fingerprint IS NULL)),
	CONSTRAINT "campaigns_scheduled_check" CHECK (state IN ('DRAFT', 'CANCELLED') OR scheduled_at IS NOT NULL),
	CONSTRAINT "campaigns_started_check" CHECK (state NOT IN ('ACTIVE', 'PAUSED') OR started_at IS NOT NULL),
	CONSTRAINT "campaigns_completed_check" CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL)),
	CONSTRAINT "campaigns_cancelled_check" CHECK ((state = 'CANCELLED') = (cancelled_at IS NOT NULL)),
	CONSTRAINT "campaigns_paused_check" CHECK ((state = 'PAUSED') = (paused_at IS NOT NULL)),
	CONSTRAINT "campaigns_audience_hash_check" CHECK (audience_hash ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "campaigns_audience_fingerprint_check" CHECK (audience_fingerprint IS NULL OR audience_fingerprint ~ '^[0-9a-f]{32}$'),
	CONSTRAINT "campaigns_confirmed_count_check" CHECK (audience_confirmed_count IS NULL OR audience_confirmed_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_campaign_fk" FOREIGN KEY ("tenant_id","campaign_id") REFERENCES "public"."campaigns"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_discount_fk" FOREIGN KEY ("tenant_id","discount_id") REFERENCES "public"."discounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_actions" ADD CONSTRAINT "campaign_actions_cashback_rule_fk" FOREIGN KEY ("tenant_id","cashback_rule_id") REFERENCES "public"."cashback_rules"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_scheduled_by_fk" FOREIGN KEY ("tenant_id","scheduled_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_cancelled_by_fk" FOREIGN KEY ("tenant_id","cancelled_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_actions_campaign_kind_key" ON "campaign_actions" USING btree ("tenant_id","campaign_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_actions_discount_key" ON "campaign_actions" USING btree ("tenant_id","discount_id") WHERE discount_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_actions_cashback_rule_key" ON "campaign_actions" USING btree ("tenant_id","cashback_rule_id") WHERE cashback_rule_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "campaigns_tenant_created_idx" ON "campaigns" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "campaigns_due_start_idx" ON "campaigns" USING btree ("tenant_id","starts_at","id") WHERE state = 'SCHEDULED';--> statement-breakpoint
CREATE INDEX "campaigns_due_end_idx" ON "campaigns" USING btree ("tenant_id","ends_at","id") WHERE state IN ('ACTIVE', 'PAUSED');