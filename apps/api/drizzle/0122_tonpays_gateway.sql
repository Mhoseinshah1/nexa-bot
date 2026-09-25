CREATE TABLE "gateway_invoices" (
	"payment_id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_order_id" text NOT NULL,
	"provider_invoice_id" text,
	"hinted_invoice_id" text,
	"creation_state" text NOT NULL,
	"creation_attempts" integer DEFAULT 0 NOT NULL,
	"creation_sent_at" timestamp with time zone,
	"creation_claimed_until" timestamp with time zone,
	"creation_retry_at" timestamp with time zone,
	"creation_error_code" text,
	"created_invoice_at" timestamp with time zone,
	"buyer_chat_id_sent" boolean DEFAULT false NOT NULL,
	"callback_url_sent" boolean DEFAULT false NOT NULL,
	"invoice_url" text,
	"web_invoice_url" text,
	"provider_unit" text NOT NULL,
	"sent_amount" bigint NOT NULL,
	"request_amount" bigint,
	"final_amount" bigint,
	"credit_amount" bigint,
	"provider_status" text,
	"provider_paid" boolean,
	"last_inquiry_at" timestamp with time zone,
	"last_inquiry_error_code" text,
	"inquiry_attempts" integer DEFAULT 0 NOT NULL,
	"next_inquiry_at" timestamp with time zone,
	"inquiry_claimed_until" timestamp with time zone,
	"post_deadline_inquiries" integer DEFAULT 0 NOT NULL,
	"webhook_status_hint" text,
	"last_webhook_at" timestamp with time zone,
	"last_webhook_delivery_id" text,
	"webhook_count" integer DEFAULT 0 NOT NULL,
	"outcome" text,
	"outcome_at" timestamp with time zone,
	"late_completion_observed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "gateway_invoices_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS')),
	CONSTRAINT "gateway_invoices_creation_state_check" CHECK (creation_state IN ('CREATING', 'CREATED', 'CREATE_FAILED', 'CREATE_UNKNOWN')),
	CONSTRAINT "gateway_invoices_outcome_check" CHECK (outcome IS NULL OR outcome IN ('SETTLED', 'ALREADY_SETTLED', 'UNSUCCESSFUL', 'LATE_COMPLETION')),
	CONSTRAINT "gateway_invoices_provider_unit_check" CHECK (provider_unit IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "gateway_invoices_sent_amount_check" CHECK (sent_amount > 0),
	CONSTRAINT "gateway_invoices_order_id_length_check" CHECK (length(provider_order_id) BETWEEN 1 AND 64),
	CONSTRAINT "gateway_invoices_created_check" CHECK ((creation_state <> 'CREATED' OR (provider_invoice_id IS NOT NULL AND created_invoice_at IS NOT NULL))
          AND (provider_invoice_id IS NULL OR creation_state IN ('CREATED', 'CREATE_UNKNOWN'))),
	CONSTRAINT "gateway_invoices_outcome_at_check" CHECK ((outcome IS NULL) = (outcome_at IS NULL))
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_call_budgets" (
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"used" integer NOT NULL,
	CONSTRAINT "payment_gateway_call_budgets_pk" PRIMARY KEY("tenant_id","provider"),
	CONSTRAINT "payment_gateway_call_budgets_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS')),
	CONSTRAINT "payment_gateway_call_budgets_used_check" CHECK (used >= 0)
);
--> statement-breakpoint
CREATE TABLE "payment_gateway_credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"api_key_ciphertext" text NOT NULL,
	"api_key_key_id" text NOT NULL,
	"api_key_set_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateway_credentials_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS'))
);
--> statement-breakpoint
ALTER TABLE "customer_notifications" DROP CONSTRAINT "customer_notifications_kind_check";--> statement-breakpoint
ALTER TABLE "payment_gateways" DROP CONSTRAINT "payment_gateways_provider_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_evidence_kind_check";--> statement-breakpoint
ALTER TABLE "payments" DROP CONSTRAINT "payments_gateway_provider_check";--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_invoices" ADD CONSTRAINT "gateway_invoices_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_call_budgets" ADD CONSTRAINT "payment_gateway_call_budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_gateway_credentials" ADD CONSTRAINT "payment_gateway_credentials_gateway_fk" FOREIGN KEY ("tenant_id","provider") REFERENCES "public"."payment_gateways"("tenant_id","provider") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_invoices_order_id_key" ON "gateway_invoices" USING btree ("tenant_id","provider","provider_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_invoices_invoice_id_key" ON "gateway_invoices" USING btree ("tenant_id","provider","provider_invoice_id") WHERE provider_invoice_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "gateway_invoices_creating_idx" ON "gateway_invoices" USING btree ("tenant_id","created_at") WHERE creation_state = 'CREATING';--> statement-breakpoint
CREATE INDEX "gateway_invoices_inquiry_due_idx" ON "gateway_invoices" USING btree ("tenant_id","next_inquiry_at") WHERE next_inquiry_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_gateway_credentials_tenant_provider_key" ON "payment_gateway_credentials" USING btree ("tenant_id","provider");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_entries_topup_gateway_payment_key" ON "wallet_entries" USING btree ("tenant_id","payment_id") WHERE reason = 'TOPUP_GATEWAY';--> statement-breakpoint
ALTER TABLE "customer_notifications" ADD CONSTRAINT "customer_notifications_kind_check" CHECK (kind IN ('PAYMENT_REJECTED', 'PAYMENT_EXPIRED', 'ORDER_EXPIRED', 'SERVICE_ACTION_SUCCEEDED', 'SERVICE_ACTION_FAILED', 'SERVICE_PROVISION_DELAYED', 'PAYMENT_TRANSFER_RECORDED', 'ORDER_CANCELLED', 'WALLET_TOPUP_CREDITED', 'ORDER_REFUNDED_TO_WALLET', 'SERVICE_EXPIRY_FIRST', 'SERVICE_EXPIRY_SECOND', 'SERVICE_EXPIRED', 'SERVICE_USAGE_FIRST', 'SERVICE_USAGE_SECOND', 'SERVICE_USAGE_FINAL', 'TRIAL_NOT_DELIVERED', 'RECEIPT_CREDITED_TO_WALLET', 'WALLET_TOPUP_GIFT_CREDITED', 'REFUND_COMPLETED', 'GATEWAY_PAYMENT_FAILED'));--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER', 'TONPAYS'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_evidence_kind_check" CHECK (evidence_kind IS NULL OR evidence_kind IN ('OPERATOR_REVIEW', 'WALLET_DEBIT', 'GATEWAY_CALLBACK', 'RECONCILIATION', 'GATEWAY_INQUIRY'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_gateway_provider_check" CHECK (gateway_provider IS NULL OR gateway_provider IN ('MANUAL_TRANSFER', 'TONPAYS'));--> statement-breakpoint
ALTER TABLE "wallet_entries" ADD CONSTRAINT "wallet_entries_topup_gateway_payment_check" CHECK (reason <> 'TOPUP_GATEWAY' OR payment_id IS NOT NULL);