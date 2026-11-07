CREATE TABLE "reseller_request_drafts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"questions" jsonb NOT NULL,
	"answers" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_request_drafts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_request_drafts_customer_key" UNIQUE("tenant_id","customer_id"),
	CONSTRAINT "reseller_request_drafts_questions_check" CHECK (jsonb_typeof(questions) = 'array'),
	CONSTRAINT "reseller_request_drafts_answers_check" CHECK (jsonb_typeof(answers) = 'array'),
	CONSTRAINT "reseller_request_drafts_position_check" CHECK (position >= 0)
);
--> statement-breakpoint
CREATE TABLE "reseller_request_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "reseller_request_messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"sender_type" text NOT NULL,
	"author_admin_id" uuid,
	"body" text,
	"attachment_kind" text,
	"attachment_bot_instance_id" uuid,
	"attachment_file_id" text,
	"attachment_file_unique_id" text,
	"attachment_mime_type" text,
	"attachment_file_size" bigint,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_request_messages_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_request_messages_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "reseller_request_messages_sender_check" CHECK (sender_type IN ('CUSTOMER', 'ADMIN')),
	CONSTRAINT "reseller_request_messages_attachment_kind_check" CHECK (attachment_kind IS NULL OR attachment_kind IN ('PHOTO')),
	CONSTRAINT "reseller_request_messages_body_check" CHECK (body IS NULL OR length(body) BETWEEN 1 AND 2000),
	CONSTRAINT "reseller_request_messages_attachment_check" CHECK ((attachment_kind IS NULL) = (attachment_file_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_file_unique_id IS NULL)
          AND (attachment_kind IS NULL) = (attachment_bot_instance_id IS NULL)),
	CONSTRAINT "reseller_request_messages_shape_check" CHECK (CASE sender_type
            WHEN 'ADMIN' THEN author_admin_id IS NOT NULL AND body IS NOT NULL AND attachment_kind IS NULL
            WHEN 'CUSTOMER' THEN author_admin_id IS NULL AND (body IS NOT NULL OR attachment_kind IS NOT NULL)
            ELSE false
          END),
	CONSTRAINT "reseller_request_messages_key_check" CHECK (length(idempotency_key) BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE "reseller_request_questions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL,
	"required" boolean NOT NULL,
	"max_length" integer DEFAULT 500 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reseller_request_questions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_request_questions_position_check" CHECK (position >= 0),
	CONSTRAINT "reseller_request_questions_text_check" CHECK (length(btrim(text)) BETWEEN 1 AND 500),
	CONSTRAINT "reseller_request_questions_max_length_check" CHECK (max_length BETWEEN 1 AND 2000)
);
--> statement-breakpoint
CREATE TABLE "reseller_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"number" bigint GENERATED ALWAYS AS IDENTITY (sequence name "reseller_requests_number_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"customer_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"answers" jsonb NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"decided_by_admin_id" uuid,
	"tier_id" uuid,
	"reason" text,
	"opening_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone,
	CONSTRAINT "reseller_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "reseller_requests_opening_key" UNIQUE("tenant_id","opening_key"),
	CONSTRAINT "reseller_requests_status_check" CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
	CONSTRAINT "reseller_requests_decided_check" CHECK ((status = 'PENDING') = (decided_at IS NULL)),
	CONSTRAINT "reseller_requests_approved_check" CHECK (status <> 'APPROVED' OR (tier_id IS NOT NULL AND decided_by_admin_id IS NOT NULL)),
	CONSTRAINT "reseller_requests_tier_only_approved_check" CHECK (status = 'APPROVED' OR tier_id IS NULL),
	CONSTRAINT "reseller_requests_reason_check" CHECK (reason IS NULL OR (status = 'REJECTED' AND length(reason) BETWEEN 1 AND 500)),
	CONSTRAINT "reseller_requests_answers_check" CHECK (jsonb_typeof(answers) = 'array'),
	CONSTRAINT "reseller_requests_opening_key_check" CHECK (length(opening_key) BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "telegram_wizards" DROP CONSTRAINT "telegram_wizards_kind_check";--> statement-breakpoint
ALTER TABLE "telegram_wizards" DROP CONSTRAINT "telegram_wizards_step_check";--> statement-breakpoint
ALTER TABLE "reseller_request_drafts" ADD CONSTRAINT "reseller_request_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_drafts" ADD CONSTRAINT "reseller_request_drafts_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_drafts" ADD CONSTRAINT "reseller_request_drafts_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_messages" ADD CONSTRAINT "reseller_request_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_messages" ADD CONSTRAINT "reseller_request_messages_attachment_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("attachment_bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_messages" ADD CONSTRAINT "reseller_request_messages_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."reseller_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_messages" ADD CONSTRAINT "reseller_request_messages_author_fk" FOREIGN KEY ("tenant_id","author_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_request_questions" ADD CONSTRAINT "reseller_request_questions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_requests" ADD CONSTRAINT "reseller_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_requests" ADD CONSTRAINT "reseller_requests_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_requests" ADD CONSTRAINT "reseller_requests_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_requests" ADD CONSTRAINT "reseller_requests_decided_by_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reseller_requests" ADD CONSTRAINT "reseller_requests_tier_fk" FOREIGN KEY ("tenant_id","tier_id") REFERENCES "public"."reseller_tiers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reseller_request_messages_request_idx" ON "reseller_request_messages" USING btree ("tenant_id","request_id","seq");--> statement-breakpoint
CREATE INDEX "reseller_request_questions_order_idx" ON "reseller_request_questions" USING btree ("tenant_id","position","id");--> statement-breakpoint
CREATE UNIQUE INDEX "reseller_requests_one_pending_key" ON "reseller_requests" USING btree ("tenant_id","customer_id") WHERE status = 'PENDING';--> statement-breakpoint
CREATE INDEX "reseller_requests_tenant_created_idx" ON "reseller_requests" USING btree ("tenant_id","created_at","id");--> statement-breakpoint
CREATE INDEX "reseller_requests_tenant_status_idx" ON "reseller_requests" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "reseller_requests_customer_decided_idx" ON "reseller_requests" USING btree ("tenant_id","customer_id","decided_at");--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'GATEWAY_LATE_PAYMENT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED', 'SERVICE_TRANSFER_RECEIVED', 'TICKET_REPLY', 'SERVICE_EXPIRY_EARLY', 'SERVICE_EXPIRY_DAY', 'WALLET_LOW_BALANCE', 'PAYMENT_PENDING_REMINDER', 'ORDER_PENDING_REMINDER', 'TICKET_REPLY_ATTACHMENT', 'SERVICE_RENEWED', 'RESELLER_MINIMUM_REMINDER', 'RESELLER_MINIMUM_ACHIEVED', 'WALLET_MASS_CREDITED', 'SERVICE_GIFT_APPLIED', 'DIRECT_MESSAGE', 'DIRECT_MESSAGE_MEDIA', 'INCIDENT_NOTICE', 'WALLET_ADMIN_CREDITED', 'WALLET_ADMIN_DEBITED', 'ACCOUNT_UNBLOCKED', 'SERVICE_TRAFFIC_ADDED', 'SERVICE_TIME_ADDED', 'SERVICE_AUTO_RENEW_FUNDS_SHORT', 'SERVICE_AUTO_RENEW_PRICE_CHANGED', 'RESELLER_EXPIRED', 'RESELLER_REQUEST_MESSAGE', 'RESELLER_REQUEST_DECISION')) NOT VALID;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'RESELLER_REQUEST_ANSWER', 'RESELLER_REQUEST_REPLY', 'RESELLER_REQUEST_ADMIN_MESSAGE', 'RESELLER_REQUEST_ADMIN_REASON', 'GATEWAY_REFUND_CARD', 'GIFT_CARD_CODE'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'GATEWAY_REFUND_CARD', 'RESELLER_REQUEST_ANSWER', 'RESELLER_REQUEST_REPLY', 'RESELLER_REQUEST_ADMIN_MESSAGE', 'RESELLER_REQUEST_ADMIN_REASON')) = (subject_id IS NOT NULL));--> statement-breakpoint
ALTER TABLE "telegram_wizards" ADD CONSTRAINT "telegram_wizards_kind_check" CHECK (kind IN ('ORDER', 'TOPUP', 'RESELLER_REQUEST'));--> statement-breakpoint
ALTER TABLE "telegram_wizards" ADD CONSTRAINT "telegram_wizards_step_check" CHECK (step IN ('CATEGORIES', 'PRODUCTS', 'USERNAME', 'DISCOUNT', 'PREINVOICE', 'AWAITING_PAYMENT', 'METHODS', 'AMOUNT', 'INVOICE_LOADING', 'INVOICE_PENDING', 'INVOICE', 'NOTICE', 'CLOSED', 'RECEIPT_WAIT', 'RECEIPT_REVIEW', 'RR_INTRO', 'RR_QUESTION', 'RR_SUMMARY'));--> statement-breakpoint
ALTER TABLE "customer_notifications" VALIDATE CONSTRAINT "customer_notifications_kind_check";