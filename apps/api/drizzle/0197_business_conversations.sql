CREATE TABLE "business_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"owner_telegram_user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"connection_row_id" uuid NOT NULL,
	"peer_telegram_user_id" text NOT NULL,
	"customer_id" uuid,
	"state" text DEFAULT 'AI_ACTIVE' NOT NULL,
	"control_epoch" integer DEFAULT 0 NOT NULL,
	"takeover_reason" text,
	"handoff_reason" text,
	"last_message_at" timestamp with time zone,
	"last_inbound_at" timestamp with time zone,
	"last_human_at" timestamp with time zone,
	"last_ai_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_conversations_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "business_conversations_state_check" CHECK (state IN ('AI_ACTIVE', 'HUMAN_ACTIVE', 'HANDOFF_REQUIRED', 'PAUSED')),
	CONSTRAINT "business_conversations_takeover_reason_check" CHECK (takeover_reason IN ('HUMAN_MESSAGE', 'OTHER_BOT', 'OPERATOR_TAKEOVER', 'OPERATOR_SEND')),
	CONSTRAINT "business_conversations_handoff_reason_check" CHECK (handoff_reason IN ('SEND_OUTCOME_UNKNOWN', 'TRANSPORT_REFUSED')),
	CONSTRAINT "business_conversations_handoff_shape_check" CHECK ((state = 'HANDOFF_REQUIRED') = (handoff_reason IS NOT NULL)),
	CONSTRAINT "business_conversations_epoch_check" CHECK (control_epoch >= 0),
	CONSTRAINT "business_conversations_chat_check" CHECK (chat_id ~ '^-?[1-9][0-9]{0,31}$'),
	CONSTRAINT "business_conversations_peer_check" CHECK (peer_telegram_user_id ~ '^[1-9][0-9]{0,31}$')
);
--> statement-breakpoint
CREATE TABLE "business_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"telegram_message_id" bigint NOT NULL,
	"origin" text NOT NULL,
	"kind" text NOT NULL,
	"text" text,
	"content_version" integer DEFAULT 1 NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"edited_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"text_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "business_messages_origin_check" CHECK (origin IN ('INBOUND', 'OWN_ECHO', 'OFFLINE', 'OTHER_BOT', 'HUMAN')),
	CONSTRAINT "business_messages_kind_check" CHECK (kind IN ('TEXT', 'PHOTO', 'OTHER')),
	CONSTRAINT "business_messages_text_check" CHECK (text IS NULL OR length(text) <= 4096),
	CONSTRAINT "business_messages_message_id_check" CHECK (telegram_message_id > 0),
	CONSTRAINT "business_messages_version_check" CHECK (content_version >= 1),
	CONSTRAINT "business_messages_deleted_check" CHECK (deleted_at IS NULL OR text IS NULL)
);
--> statement-breakpoint
CREATE TABLE "business_outbound_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"body" text,
	"created_by_admin_id" uuid,
	"control_epoch" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"telegram_message_id" bigint,
	"failure_code" text,
	"body_purged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_outbound_messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "business_outbound_messages_origin_check" CHECK (origin IN ('OPERATOR', 'ASSIST', 'AUTO')),
	CONSTRAINT "business_outbound_messages_state_check" CHECK (state IN ('PENDING', 'DELIVERED', 'UNCONFIRMED', 'FAILED', 'SUPERSEDED')),
	CONSTRAINT "business_outbound_messages_body_check" CHECK (body IS NULL OR length(body) BETWEEN 1 AND 4096),
	CONSTRAINT "business_outbound_messages_author_check" CHECK ((origin = 'AUTO') = (created_by_admin_id IS NULL)),
	CONSTRAINT "business_outbound_messages_resolved_check" CHECK ((state = 'PENDING') = (resolved_at IS NULL)),
	CONSTRAINT "business_outbound_messages_attempts_check" CHECK (attempts >= 0),
	CONSTRAINT "business_outbound_messages_epoch_check" CHECK (control_epoch >= 0)
);
--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_connection_fk" FOREIGN KEY ("tenant_id","connection_row_id") REFERENCES "public"."telegram_business_connections"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_conversations" ADD CONSTRAINT "business_conversations_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_outbound_messages" ADD CONSTRAINT "business_outbound_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_outbound_messages" ADD CONSTRAINT "business_outbound_messages_conversation_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."business_conversations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "business_outbound_messages" ADD CONSTRAINT "business_outbound_messages_admin_fk" FOREIGN KEY ("tenant_id","created_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "business_conversations_chat_key" ON "business_conversations" USING btree ("bot_instance_id","owner_telegram_user_id","chat_id");--> statement-breakpoint
CREATE INDEX "business_conversations_inbox_idx" ON "business_conversations" USING btree ("tenant_id","last_message_at");--> statement-breakpoint
CREATE UNIQUE INDEX "business_messages_message_key" ON "business_messages" USING btree ("conversation_id","telegram_message_id");--> statement-breakpoint
CREATE INDEX "business_messages_conversation_idx" ON "business_messages" USING btree ("tenant_id","conversation_id","sent_at");--> statement-breakpoint
CREATE INDEX "business_messages_retention_idx" ON "business_messages" USING btree ("tenant_id","sent_at") WHERE text IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "business_outbound_messages_idempotency_key" ON "business_outbound_messages" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "business_outbound_messages_due_idx" ON "business_outbound_messages" USING btree ("tenant_id","next_attempt_at") WHERE state = 'PENDING';--> statement-breakpoint
CREATE INDEX "business_outbound_messages_conversation_idx" ON "business_outbound_messages" USING btree ("tenant_id","conversation_id","created_at");