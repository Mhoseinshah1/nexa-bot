CREATE TABLE "service_refund_request_pushes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"admin_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"state" text DEFAULT 'PENDING' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"send_started_at" timestamp with time zone,
	"chat_id" text,
	"last_error_code" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_refund_request_pushes_request_admin_key" UNIQUE("tenant_id","request_id","admin_id"),
	CONSTRAINT "service_refund_request_pushes_state_check" CHECK (state IN ('PENDING', 'DELIVERED', 'UNKNOWN', 'FAILED', 'SUPERSEDED')),
	CONSTRAINT "service_refund_request_pushes_resolved_check" CHECK ((state <> 'PENDING') = (resolved_at IS NOT NULL)),
	CONSTRAINT "service_refund_request_pushes_attempts_check" CHECK (attempts >= 0)
);
--> statement-breakpoint
CREATE TABLE "service_refund_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"state" text DEFAULT 'OPEN' NOT NULL,
	"reason" text NOT NULL,
	"filing_key" text NOT NULL,
	"principal_minor" bigint NOT NULL,
	"currency" text NOT NULL,
	"approved_amount_minor" bigint,
	"refund_id" uuid,
	"operation_id" uuid,
	"decided_by_admin_id" uuid,
	"decided_at" timestamp with time zone,
	"rejection_reason" text,
	"failure_kind" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_refund_requests_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "service_refund_requests_refund_key" UNIQUE("tenant_id","refund_id"),
	CONSTRAINT "service_refund_requests_filing_key" UNIQUE("tenant_id","filing_key"),
	CONSTRAINT "service_refund_requests_state_check" CHECK (state IN ('OPEN', 'EXECUTING', 'COMPLETED', 'REJECTED', 'FAILED')),
	CONSTRAINT "service_refund_requests_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "service_refund_requests_reason_check" CHECK (reason = btrim(reason) AND char_length(reason) BETWEEN 3 AND 500),
	CONSTRAINT "service_refund_requests_principal_check" CHECK (principal_minor > 0),
	CONSTRAINT "service_refund_requests_open_check" CHECK (state <> 'OPEN' OR (approved_amount_minor IS NULL AND refund_id IS NULL
          AND operation_id IS NULL AND decided_by_admin_id IS NULL AND decided_at IS NULL
          AND rejection_reason IS NULL)),
	CONSTRAINT "service_refund_requests_approved_check" CHECK (state NOT IN ('EXECUTING', 'COMPLETED', 'FAILED') OR (approved_amount_minor > 0
          AND approved_amount_minor <= principal_minor AND refund_id IS NOT NULL
          AND operation_id IS NOT NULL AND decided_by_admin_id IS NOT NULL
          AND decided_at IS NOT NULL AND rejection_reason IS NULL)),
	CONSTRAINT "service_refund_requests_rejected_check" CHECK (state <> 'REJECTED' OR (rejection_reason IS NOT NULL
          AND length(btrim(rejection_reason)) BETWEEN 1 AND 500
          AND decided_by_admin_id IS NOT NULL AND decided_at IS NOT NULL
          AND approved_amount_minor IS NULL AND refund_id IS NULL AND operation_id IS NULL)),
	CONSTRAINT "service_refund_requests_resolved_check" CHECK ((state IN ('COMPLETED', 'REJECTED', 'FAILED')) = (resolved_at IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_target_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_confirmed_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" DROP CONSTRAINT "admin_amount_captures_purpose_column_check";--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "service_refund_request_id" uuid;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD COLUMN "opened_update_id" bigint;--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD COLUMN "opened_update_id" bigint;--> statement-breakpoint
ALTER TABLE "service_refund_request_pushes" ADD CONSTRAINT "service_refund_request_pushes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_request_pushes" ADD CONSTRAINT "service_refund_request_pushes_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_request_pushes" ADD CONSTRAINT "service_refund_request_pushes_request_fk" FOREIGN KEY ("tenant_id","request_id") REFERENCES "public"."service_refund_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_request_pushes" ADD CONSTRAINT "service_refund_request_pushes_admin_fk" FOREIGN KEY ("tenant_id","admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_service_fk" FOREIGN KEY ("tenant_id","service_id") REFERENCES "public"."services"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_order_fk" FOREIGN KEY ("tenant_id","order_id") REFERENCES "public"."orders"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_refund_fk" FOREIGN KEY ("tenant_id","refund_id") REFERENCES "public"."refunds"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_operation_fk" FOREIGN KEY ("tenant_id","operation_id") REFERENCES "public"."provisioning_operations"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_refund_requests" ADD CONSTRAINT "service_refund_requests_admin_fk" FOREIGN KEY ("tenant_id","decided_by_admin_id") REFERENCES "public"."admins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "service_refund_request_pushes_due_idx" ON "service_refund_request_pushes" USING btree ("tenant_id","next_attempt_at") WHERE state = 'PENDING';--> statement-breakpoint
CREATE UNIQUE INDEX "service_refund_requests_active_key" ON "service_refund_requests" USING btree ("tenant_id","service_id") WHERE state IN ('OPEN', 'EXECUTING');--> statement-breakpoint
CREATE INDEX "service_refund_requests_state_idx" ON "service_refund_requests" USING btree ("tenant_id","state","created_at");--> statement-breakpoint
CREATE INDEX "service_refund_requests_service_idx" ON "service_refund_requests" USING btree ("tenant_id","service_id","created_at");--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_refund_request_fk" FOREIGN KEY ("tenant_id","service_refund_request_id") REFERENCES "public"."service_refund_requests"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_target_check" CHECK ((purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON')
            AND payment_id IS NOT NULL AND customer_id IS NULL AND service_refund_request_id IS NULL)
          OR (purpose = 'CUSTOMER_BLOCK_REASON' AND customer_id IS NOT NULL AND payment_id IS NULL
            AND service_refund_request_id IS NULL)
          OR (purpose IN ('SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON')
            AND service_refund_request_id IS NOT NULL AND payment_id IS NULL AND customer_id IS NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_confirmed_check" CHECK (close_reason IS DISTINCT FROM 'CONFIRMED'
          OR (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND amount_minor IS NOT NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND reason IS NOT NULL));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_check" CHECK (purpose IN ('RECEIPT_CREDIT_AMOUNT', 'RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_AMOUNT', 'SERVICE_REFUND_REJECT_REASON'));--> statement-breakpoint
ALTER TABLE "admin_amount_captures" ADD CONSTRAINT "admin_amount_captures_purpose_column_check" CHECK ((purpose IN ('RECEIPT_CREDIT_AMOUNT', 'SERVICE_REFUND_AMOUNT') AND reason IS NULL)
          OR (purpose IN ('RECEIPT_BLOCK_REASON', 'RECEIPT_REJECT_REASON', 'CUSTOMER_BLOCK_REASON', 'SERVICE_REFUND_REJECT_REASON') AND amount_minor IS NULL));--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED', 'SERVICE_REFUND_REQUEST_REGISTERED', 'SERVICE_REFUND_REQUEST_APPROVED', 'SERVICE_REFUND_REQUEST_REJECTED'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON')) = (subject_id IS NOT NULL));