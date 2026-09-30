CREATE TABLE "bot_appearance_slots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"slot" text NOT NULL,
	"custom_emoji_id" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by_admin_id" uuid,
	CONSTRAINT "bot_appearance_slots_slot_check" CHECK (slot IN ('success', 'error', 'warning', 'info', 'payment', 'wallet', 'purchase', 'service', 'trial', 'referral', 'support', 'ticket', 'renewal', 'traffic', 'time', 'date', 'link', 'user', 'location', 'active', 'inactive')),
	CONSTRAINT "bot_appearance_slots_custom_emoji_id_check" CHECK (custom_emoji_id IS NULL OR custom_emoji_id ~ '^[0-9]{1,32}$'),
	CONSTRAINT "bot_appearance_slots_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "bot_instances" ADD COLUMN "custom_emoji_tested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bot_instances" ADD COLUMN "custom_emoji_test_outcome" text;--> statement-breakpoint
ALTER TABLE "bot_instances" ADD COLUMN "custom_emoji_test_error_code" text;--> statement-breakpoint
ALTER TABLE "bot_appearance_slots" ADD CONSTRAINT "bot_appearance_slots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_appearance_slots" ADD CONSTRAINT "bot_appearance_slots_tenant_admin_fk" FOREIGN KEY ("tenant_id","updated_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bot_appearance_slots_tenant_slot_key" ON "bot_appearance_slots" USING btree ("tenant_id","slot");--> statement-breakpoint
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_custom_emoji_test_outcome_check" CHECK (custom_emoji_test_outcome IN ('SENT', 'REJECTED', 'UNREACHABLE', 'RATE_LIMITED'));--> statement-breakpoint
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_custom_emoji_test_error_code_check" CHECK (custom_emoji_test_error_code IN ('appearance.custom_emoji_refused', 'appearance.chat_unavailable', 'appearance.telegram_rejected', 'appearance.telegram_unreachable', 'appearance.rate_limited'));--> statement-breakpoint
ALTER TABLE "bot_instances" ADD CONSTRAINT "bot_instances_custom_emoji_test_shape_check" CHECK ((custom_emoji_tested_at IS NULL AND custom_emoji_test_outcome IS NULL AND custom_emoji_test_error_code IS NULL)
        OR (custom_emoji_tested_at IS NOT NULL AND custom_emoji_test_outcome IS NOT NULL
            AND ((custom_emoji_test_outcome = 'SENT') = (custom_emoji_test_error_code IS NULL))));