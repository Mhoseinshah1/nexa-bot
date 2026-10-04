CREATE TABLE "telegram_business_connections" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"connection_id" text NOT NULL,
	"owner_telegram_user_id" text NOT NULL,
	"owner_user_chat_id" text NOT NULL,
	"is_enabled" boolean NOT NULL,
	"rights" text[] DEFAULT '{}'::text[] NOT NULL,
	"connected_at" timestamp with time zone NOT NULL,
	"last_confirmed_at" timestamp with time zone NOT NULL,
	"superseded_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_business_connections_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "telegram_business_connections_rights_check" CHECK (rights <@ ARRAY['can_reply', 'can_read_messages', 'can_delete_outgoing_messages', 'can_delete_all_messages', 'can_edit_name', 'can_edit_bio', 'can_edit_profile_photo', 'can_edit_username', 'can_change_gift_settings', 'can_view_gifts_and_stars', 'can_convert_gifts_to_stars', 'can_transfer_and_upgrade_gifts', 'can_transfer_stars', 'can_manage_stories']::text[]),
	CONSTRAINT "telegram_business_connections_owner_check" CHECK (owner_telegram_user_id ~ '^[1-9][0-9]{0,31}$'),
	CONSTRAINT "telegram_business_connections_owner_chat_check" CHECK (owner_user_chat_id ~ '^-?[1-9][0-9]{0,31}$'),
	CONSTRAINT "telegram_business_connections_connection_id_check" CHECK (length(connection_id) BETWEEN 1 AND 256),
	CONSTRAINT "telegram_business_connections_version_check" CHECK (version >= 1)
);
--> statement-breakpoint
ALTER TABLE "telegram_business_connections" ADD CONSTRAINT "telegram_business_connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_business_connections" ADD CONSTRAINT "telegram_business_connections_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_business_connections_bot_connection_key" ON "telegram_business_connections" USING btree ("bot_instance_id","connection_id");--> statement-breakpoint
CREATE INDEX "telegram_business_connections_owner_idx" ON "telegram_business_connections" USING btree ("tenant_id","bot_instance_id","owner_telegram_user_id");