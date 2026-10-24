CREATE TABLE "gateway_invoice_provider_facts" (
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"need" text,
	"remaining_amount" bigint,
	"remaining_card_number" text,
	"remaining_card_holder" text,
	"remaining_invoice_id" text,
	"remaining_receipt_received" boolean,
	"refund_amount" bigint,
	"refund_pending" boolean,
	"reject_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"observed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "gateway_invoice_provider_facts_tenant_id_payment_id_pk" PRIMARY KEY("tenant_id","payment_id"),
	CONSTRAINT "gateway_invoice_provider_facts_need_check" CHECK (need IS NULL OR need IN ('LESS', 'MORE')),
	CONSTRAINT "gateway_invoice_provider_facts_shape_check" CHECK ((need = 'LESS' OR (remaining_amount IS NULL AND remaining_card_number IS NULL AND remaining_card_holder IS NULL AND remaining_invoice_id IS NULL AND remaining_receipt_received IS NULL))
          AND (need = 'MORE' OR (refund_amount IS NULL AND refund_pending IS NULL))
          AND (remaining_amount IS NULL OR remaining_amount > 0)
          AND (refund_amount IS NULL OR refund_amount > 0)
          AND (remaining_invoice_id IS NULL OR remaining_invoice_id ~ '^[A-Za-z0-9_-]{1,64}$')
          AND (remaining_card_number IS NULL OR length(remaining_card_number) BETWEEN 1 AND 64)
          AND (remaining_card_holder IS NULL OR length(remaining_card_holder) BETWEEN 1 AND 128)),
	CONSTRAINT "gateway_invoice_provider_facts_reasons_check" CHECK (jsonb_typeof(reject_reasons) = 'array' AND jsonb_array_length(reject_reasons) <= 10)
);
--> statement-breakpoint
CREATE TABLE "gateway_provider_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"bot_instance_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"state" text NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"claimed_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"error_code" text,
	"idempotency_key" text NOT NULL,
	"refund_card_masked" text,
	"refund_card_ciphertext" text,
	"refund_card_key_id" text,
	CONSTRAINT "gateway_provider_requests_kind_check" CHECK (kind IN ('CANCEL', 'REFUND')),
	CONSTRAINT "gateway_provider_requests_state_check" CHECK (state IN ('REQUESTED', 'SENT', 'APPLIED', 'REFUSED', 'RATE_LIMITED', 'UNKNOWN')),
	CONSTRAINT "gateway_provider_requests_decided_check" CHECK ((state IN ('REQUESTED', 'SENT')) = (decided_at IS NULL) AND (state <> 'SENT' OR sent_at IS NOT NULL) AND (state <> 'REQUESTED' OR sent_at IS NULL)),
	CONSTRAINT "gateway_provider_requests_error_code_check" CHECK (error_code IS NULL OR length(error_code) BETWEEN 1 AND 64),
	CONSTRAINT "gateway_provider_requests_refund_card_check" CHECK ((kind = 'REFUND') = (refund_card_masked IS NOT NULL)
          AND (refund_card_masked IS NULL OR refund_card_masked ~ '^[0-9]{6}[*]{6}[0-9]{4}$')),
	CONSTRAINT "gateway_provider_requests_sealed_card_check" CHECK (((kind = 'REFUND' AND state = 'REQUESTED') = (refund_card_ciphertext IS NOT NULL))
          AND ((refund_card_ciphertext IS NULL) = (refund_card_key_id IS NULL)))
);
--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_purpose_check";--> statement-breakpoint
ALTER TABLE "customer_text_captures" DROP CONSTRAINT "customer_text_captures_subject_check";--> statement-breakpoint
ALTER TABLE "gateway_invoice_provider_facts" ADD CONSTRAINT "gateway_invoice_provider_facts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_invoice_provider_facts" ADD CONSTRAINT "gateway_invoice_provider_facts_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_provider_requests" ADD CONSTRAINT "gateway_provider_requests_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_provider_requests" ADD CONSTRAINT "gateway_provider_requests_bot_instance_id_bot_instances_id_fk" FOREIGN KEY ("bot_instance_id") REFERENCES "public"."bot_instances"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_provider_requests" ADD CONSTRAINT "gateway_provider_requests_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_provider_requests" ADD CONSTRAINT "gateway_provider_requests_customer_fk" FOREIGN KEY ("tenant_id","customer_id") REFERENCES "public"."customers"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_provider_requests_in_flight_key" ON "gateway_provider_requests" USING btree ("tenant_id","payment_id","kind") WHERE state IN ('REQUESTED', 'SENT');--> statement-breakpoint
CREATE UNIQUE INDEX "gateway_provider_requests_idempotency_key" ON "gateway_provider_requests" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "gateway_provider_requests_due_idx" ON "gateway_provider_requests" USING btree ("tenant_id","requested_at") WHERE state IN ('REQUESTED', 'SENT');--> statement-breakpoint
CREATE INDEX "gateway_provider_requests_payment_idx" ON "gateway_provider_requests" USING btree ("tenant_id","payment_id","kind","requested_at");--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_purpose_check" CHECK (purpose IN ('TOPUP_AMOUNT', 'SERVICE_SEARCH', 'SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'GATEWAY_REFUND_CARD'));--> statement-breakpoint
ALTER TABLE "customer_text_captures" ADD CONSTRAINT "customer_text_captures_subject_check" CHECK ((purpose IN ('SERVICE_NOTE', 'SERVICE_REFUND_REASON', 'CUSTOM_SERVICE_VOLUME', 'CUSTOM_SERVICE_DAYS', 'SERVICE_TRANSFER_RECIPIENT', 'TICKET_NEW_MESSAGE', 'TICKET_REPLY', 'GATEWAY_REFUND_CARD')) = (subject_id IS NOT NULL));