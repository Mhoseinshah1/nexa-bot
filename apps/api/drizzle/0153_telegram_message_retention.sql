CREATE TABLE "telegram_message_horizons" (
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"purged_through_message_id" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_message_horizons_pkey" PRIMARY KEY("tenant_id","bot_instance_id","chat_id"),
	CONSTRAINT "telegram_message_horizons_message_check" CHECK (purged_through_message_id > 0)
);
--> statement-breakpoint
ALTER TABLE "telegram_message_horizons" ADD CONSTRAINT "telegram_message_horizons_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_message_horizons" ADD CONSTRAINT "telegram_message_horizons_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;