CREATE TABLE "ops_log_connect_codes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"issued_by_admin_id" uuid NOT NULL,
	"issued_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"consumed_chat_id" text,
	CONSTRAINT "ops_log_connect_codes_expiry_check" CHECK (expires_at > issued_at),
	CONSTRAINT "ops_log_connect_codes_consumed_check" CHECK ((consumed_at IS NULL) = (consumed_chat_id IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ops_log_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text NOT NULL,
	"health" text DEFAULT 'UNVERIFIED' NOT NULL,
	"problems" text[] DEFAULT '{}'::text[] NOT NULL,
	"bot_member_status" text,
	"checked_at" timestamp with time zone,
	"last_delivered_at" timestamp with time zone,
	"connected_by_admin_id" uuid,
	"connected_at" timestamp with time zone NOT NULL,
	"disconnected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_log_groups_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ops_log_groups_status_check" CHECK (status IN ('CONNECTED', 'DISCONNECTED')),
	CONSTRAINT "ops_log_groups_health_check" CHECK (health IN ('UNVERIFIED', 'HEALTHY', 'PROBLEM')),
	CONSTRAINT "ops_log_groups_problems_check" CHECK (problems <@ ARRAY['NOT_FORUM', 'BOT_NOT_ADMIN', 'CANNOT_SEND', 'CANNOT_MANAGE_TOPICS', 'BOT_REMOVED', 'CHAT_UNREACHABLE', 'BOT_INACTIVE', 'TOPIC_CREATE_FAILED']::text[]),
	CONSTRAINT "ops_log_groups_chat_check" CHECK (chat_id ~ '^-?[0-9]{1,32}$'),
	CONSTRAINT "ops_log_groups_disconnected_check" CHECK ((status = 'DISCONNECTED') = (disconnected_at IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ops_log_topics" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"category" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"message_thread_id" bigint,
	"creation_claim_token" uuid,
	"creation_claimed_until" timestamp with time zone,
	"recreated_count" integer DEFAULT 0 NOT NULL,
	"last_delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ops_log_topics_state_check" CHECK (state IN ('PENDING', 'READY', 'MISSING')),
	CONSTRAINT "ops_log_topics_category_check" CHECK (category ~ '^[A-Z][A-Z0-9_]{0,31}$'),
	CONSTRAINT "ops_log_topics_ready_check" CHECK (state <> 'READY' OR message_thread_id IS NOT NULL),
	CONSTRAINT "ops_log_topics_recreated_check" CHECK (recreated_count >= 0)
);
--> statement-breakpoint
ALTER TABLE "ops_log_connect_codes" ADD CONSTRAINT "ops_log_connect_codes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_connect_codes" ADD CONSTRAINT "ops_log_connect_codes_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_connect_codes" ADD CONSTRAINT "ops_log_connect_codes_admin_fk" FOREIGN KEY ("tenant_id","issued_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_groups" ADD CONSTRAINT "ops_log_groups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_groups" ADD CONSTRAINT "ops_log_groups_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_groups" ADD CONSTRAINT "ops_log_groups_admin_fk" FOREIGN KEY ("tenant_id","connected_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_topics" ADD CONSTRAINT "ops_log_topics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ops_log_topics" ADD CONSTRAINT "ops_log_topics_group_fk" FOREIGN KEY ("tenant_id","group_id") REFERENCES "public"."ops_log_groups"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ops_log_connect_codes_hash_key" ON "ops_log_connect_codes" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "ops_log_connect_codes_tenant_issued_idx" ON "ops_log_connect_codes" USING btree ("tenant_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ops_log_groups_tenant_key" ON "ops_log_groups" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ops_log_groups_check_idx" ON "ops_log_groups" USING btree ("health","checked_at") WHERE status = 'CONNECTED';--> statement-breakpoint
CREATE UNIQUE INDEX "ops_log_topics_chat_category_key" ON "ops_log_topics" USING btree ("tenant_id","chat_id","category");