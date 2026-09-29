CREATE TABLE "ticket_reply_files" (
	"tenant_id" uuid NOT NULL,
	"message_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"mime_type" text NOT NULL,
	"file_name" text NOT NULL,
	"byte_length" integer NOT NULL,
	"sha256" text NOT NULL,
	"content" "bytea",
	"purged_at" timestamp with time zone,
	"telegram_file_id" text,
	"telegram_file_unique_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ticket_reply_files_pk" PRIMARY KEY("tenant_id","message_id"),
	CONSTRAINT "ticket_reply_files_kind_check" CHECK (kind IN ('PHOTO', 'DOCUMENT')),
	CONSTRAINT "ticket_reply_files_type_check" CHECK (CASE mime_type WHEN 'image/jpeg' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'image/png' THEN kind = 'PHOTO' AND byte_length BETWEEN 1 AND 5242880 WHEN 'application/pdf' THEN kind = 'DOCUMENT' AND byte_length BETWEEN 1 AND 10485760 WHEN 'text/plain' THEN kind = 'DOCUMENT' AND byte_length BETWEEN 1 AND 1048576 ELSE false END),
	CONSTRAINT "ticket_reply_files_content_check" CHECK ((content IS NULL) = (purged_at IS NOT NULL)
          AND (content IS NULL OR octet_length(content) = byte_length)),
	CONSTRAINT "ticket_reply_files_telegram_check" CHECK ((telegram_file_id IS NULL) = (telegram_file_unique_id IS NULL)),
	CONSTRAINT "ticket_reply_files_sha256_check" CHECK (sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "ticket_reply_files_name_check" CHECK (length(file_name) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "ticket_reply_files" ADD CONSTRAINT "ticket_reply_files_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reply_files" ADD CONSTRAINT "ticket_reply_files_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reply_files" ADD CONSTRAINT "ticket_reply_files_message_fk" FOREIGN KEY ("tenant_id","message_id") REFERENCES "public"."ticket_messages"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reply_files" ADD CONSTRAINT "ticket_reply_files_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "public"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ticket_reply_files_staged_idx" ON "ticket_reply_files" USING btree ("tenant_id","created_at") WHERE content IS NOT NULL;--> statement-breakpoint
CREATE INDEX "ticket_reply_files_retention_idx" ON "ticket_reply_files" USING btree ("created_at") WHERE content IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT'));