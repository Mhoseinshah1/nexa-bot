CREATE TABLE "customer_direct_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"author_admin_id" uuid NOT NULL,
	"content_kind" text NOT NULL,
	"body" text,
	"file_mime_type" text,
	"file_name" text,
	"file_byte_length" integer,
	"file_sha256" text,
	"file_content" "bytea",
	"file_purged_at" timestamp with time zone,
	"telegram_file_id" text,
	"telegram_file_unique_id" text,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customer_direct_messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "customer_direct_messages_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "customer_direct_messages_kind_check" CHECK (content_kind IN ('TEXT', 'PHOTO', 'DOCUMENT')),
	CONSTRAINT "customer_direct_messages_body_check" CHECK (body IS NULL OR length(body) BETWEEN 1 AND 3000),
	CONSTRAINT "customer_direct_messages_shape_check" CHECK (CASE content_kind
            WHEN 'TEXT' THEN body IS NOT NULL AND file_mime_type IS NULL AND file_name IS NULL
              AND file_byte_length IS NULL AND file_sha256 IS NULL AND file_content IS NULL
              AND file_purged_at IS NULL AND telegram_file_id IS NULL
            ELSE file_mime_type IS NOT NULL AND file_name IS NOT NULL
              AND file_byte_length IS NOT NULL AND file_sha256 IS NOT NULL
          END),
	CONSTRAINT "customer_direct_messages_file_type_check" CHECK (file_mime_type IS NULL OR CASE file_mime_type WHEN 'image/jpeg' THEN content_kind = 'PHOTO' AND file_byte_length BETWEEN 1 AND 5242880 WHEN 'image/png' THEN content_kind = 'PHOTO' AND file_byte_length BETWEEN 1 AND 5242880 WHEN 'application/pdf' THEN content_kind = 'DOCUMENT' AND file_byte_length BETWEEN 1 AND 10485760 WHEN 'text/plain' THEN content_kind = 'DOCUMENT' AND file_byte_length BETWEEN 1 AND 1048576 ELSE false END),
	CONSTRAINT "customer_direct_messages_file_content_check" CHECK (content_kind = 'TEXT'
          OR ((file_content IS NULL) = (file_purged_at IS NOT NULL)
              AND (file_content IS NULL OR octet_length(file_content) = file_byte_length))),
	CONSTRAINT "customer_direct_messages_telegram_check" CHECK ((telegram_file_id IS NULL) = (telegram_file_unique_id IS NULL)),
	CONSTRAINT "customer_direct_messages_sha256_check" CHECK (file_sha256 IS NULL OR file_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "customer_direct_messages_name_check" CHECK (file_name IS NULL OR length(file_name) BETWEEN 1 AND 200)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customer_direct_messages" ADD CONSTRAINT "customer_direct_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_direct_messages" ADD CONSTRAINT "customer_direct_messages_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_direct_messages" ADD CONSTRAINT "customer_direct_messages_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_direct_messages" ADD CONSTRAINT "customer_direct_messages_author_fk" FOREIGN KEY ("tenant_id","author_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_direct_messages_customer_idx" ON "customer_direct_messages" USING btree ("tenant_id","customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "customer_direct_messages_admin_idx" ON "customer_direct_messages" USING btree ("tenant_id","author_admin_id","created_at");--> statement-breakpoint
CREATE INDEX "customer_direct_messages_staged_idx" ON "customer_direct_messages" USING btree ("tenant_id","created_at") WHERE file_content IS NOT NULL;--> statement-breakpoint
CREATE INDEX "customer_direct_messages_retention_idx" ON "customer_direct_messages" USING btree ("created_at") WHERE file_content IS NOT NULL;--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA'));