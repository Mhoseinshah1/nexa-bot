CREATE TABLE "operation_card_messages" (
	"tenant_id" uuid NOT NULL,
	"operation_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" bigint NOT NULL,
	"answered_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operation_card_messages_pkey" PRIMARY KEY("tenant_id","operation_id"),
	CONSTRAINT "operation_card_messages_message_id_check" CHECK (message_id > 0),
	CONSTRAINT "operation_card_messages_chat_id_check" CHECK (chat_id ~ '^-?[0-9]{1,20}$')
);
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "usage_refresh_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operation_card_messages" ADD CONSTRAINT "operation_card_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_card_messages" ADD CONSTRAINT "operation_card_messages_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."provisioning_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_card_messages_unanswered_idx" ON "operation_card_messages" USING btree ("tenant_id","created_at") WHERE answered_at IS NULL;