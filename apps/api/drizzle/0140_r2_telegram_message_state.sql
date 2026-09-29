CREATE TABLE "telegram_review_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" bigint NOT NULL,
	"payment_id" uuid NOT NULL,
	"role" text NOT NULL,
	"has_media" boolean NOT NULL,
	"finalised_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_review_messages_role_check" CHECK (role IN ('REVIEW', 'PROMPT')),
	CONSTRAINT "telegram_review_messages_message_check" CHECK (message_id > 0)
);
--> statement-breakpoint
CREATE TABLE "telegram_wizards" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"chat_id" text NOT NULL,
	"message_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"step" text NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"subject_id" uuid,
	"payment_id" uuid,
	"busy_until" timestamp with time zone,
	"last_update_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "telegram_wizards_kind_check" CHECK (kind IN ('ORDER', 'TOPUP')),
	CONSTRAINT "telegram_wizards_step_check" CHECK (step IN ('CATEGORIES', 'PRODUCTS', 'USERNAME', 'DISCOUNT', 'PREINVOICE', 'AWAITING_PAYMENT', 'METHODS', 'AMOUNT', 'INVOICE_PENDING', 'INVOICE', 'NOTICE', 'CLOSED')),
	CONSTRAINT "telegram_wizards_version_check" CHECK (version >= 0),
	CONSTRAINT "telegram_wizards_message_check" CHECK (message_id > 0)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "telegram_review_messages" ADD CONSTRAINT "telegram_review_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_review_messages" ADD CONSTRAINT "telegram_review_messages_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_review_messages" ADD CONSTRAINT "telegram_review_messages_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_wizards" ADD CONSTRAINT "telegram_wizards_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telegram_wizards" ADD CONSTRAINT "telegram_wizards_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_review_messages_message_key" ON "telegram_review_messages" USING btree ("tenant_id","bot_instance_id","chat_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_review_messages_payment_idx" ON "telegram_review_messages" USING btree ("tenant_id","payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "telegram_wizards_message_key" ON "telegram_wizards" USING btree ("tenant_id","bot_instance_id","chat_id","message_id");--> statement-breakpoint
CREATE INDEX "telegram_wizards_payment_idx" ON "telegram_wizards" USING btree ("tenant_id","payment_id") WHERE payment_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "telegram_wizards_subject_idx" ON "telegram_wizards" USING btree ("tenant_id","subject_id") WHERE subject_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "telegram_wizards_chat_idx" ON "telegram_wizards" USING btree ("tenant_id","bot_instance_id","chat_id","updated_at");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED'));