CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"order_id" uuid,
	"state" text DEFAULT 'REQUESTED' NOT NULL,
	"channel" text NOT NULL,
	"amount" bigint NOT NULL,
	"currency" text NOT NULL,
	"reason" text NOT NULL,
	"requested_by_admin_id" uuid,
	"completed_by_admin_id" uuid,
	"completed_at" timestamp with time zone,
	"external_reference" text,
	"completion_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refunds_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "refunds_state_check" CHECK (state IN ('REQUESTED', 'AWAITING_EXTERNAL', 'COMPLETED', 'FAILED')),
	CONSTRAINT "refunds_channel_check" CHECK (channel IN ('WALLET_CREDIT', 'EXTERNAL_MANUAL', 'PROVIDER')),
	CONSTRAINT "refunds_currency_check" CHECK (currency IN ('IRT', 'IRR', 'USD', 'EUR', 'USDT')),
	CONSTRAINT "refunds_amount_check" CHECK (amount > 0),
	CONSTRAINT "refunds_reason_check" CHECK (length(btrim(reason)) BETWEEN 3 AND 500),
	CONSTRAINT "refunds_external_reference_check" CHECK (external_reference IS NULL OR length(btrim(external_reference)) BETWEEN 1 AND 140),
	CONSTRAINT "refunds_completed_check" CHECK ((state = 'COMPLETED') = (completed_at IS NOT NULL AND completed_by_admin_id IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_fk" FOREIGN KEY ("tenant_id","payment_id") REFERENCES "public"."payments"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "refunds_tenant_payment_idx" ON "refunds" USING btree ("tenant_id","payment_id","created_at");--> statement-breakpoint
CREATE INDEX "refunds_tenant_customer_idx" ON "refunds" USING btree ("tenant_id","customer_id","created_at");