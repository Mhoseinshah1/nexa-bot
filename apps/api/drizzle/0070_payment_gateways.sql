CREATE TABLE "payment_gateways" (
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"display_name" text,
	"instructions" text,
	"min_amount_minor" bigint DEFAULT 0 NOT NULL,
	"max_amount_minor" bigint DEFAULT 0 NOT NULL,
	"activate_after_payments" integer DEFAULT 0 NOT NULL,
	"deactivate_after_payments" integer DEFAULT 0 NOT NULL,
	"activate_after_account_days" integer DEFAULT 0 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_gateways_pk" PRIMARY KEY("tenant_id","provider"),
	CONSTRAINT "payment_gateways_provider_check" CHECK (provider IN ('MANUAL_TRANSFER')),
	CONSTRAINT "payment_gateways_status_check" CHECK (status IN ('ACTIVE', 'DISABLED')),
	CONSTRAINT "payment_gateways_amount_window_check" CHECK (max_amount_minor = 0 OR max_amount_minor >= min_amount_minor),
	CONSTRAINT "payment_gateways_min_amount_check" CHECK (min_amount_minor >= 0),
	CONSTRAINT "payment_gateways_max_amount_check" CHECK (max_amount_minor >= 0),
	CONSTRAINT "payment_gateways_payment_window_check" CHECK (activate_after_payments = 0
          OR deactivate_after_payments = 0
          OR deactivate_after_payments > activate_after_payments),
	CONSTRAINT "payment_gateways_thresholds_check" CHECK (activate_after_payments BETWEEN 0 AND 100000
          AND deactivate_after_payments BETWEEN 0 AND 100000
          AND activate_after_account_days BETWEEN 0 AND 100000),
	CONSTRAINT "payment_gateways_display_name_check" CHECK (display_name IS NULL OR length(btrim(display_name)) BETWEEN 1 AND 60),
	CONSTRAINT "payment_gateways_instructions_check" CHECK (instructions IS NULL OR length(instructions) BETWEEN 1 AND 1000),
	CONSTRAINT "payment_gateways_sort_order_check" CHECK (sort_order BETWEEN 0 AND 100000)
);
--> statement-breakpoint
ALTER TABLE "payment_gateways" ADD CONSTRAINT "payment_gateways_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_gateways_tenant_sort_idx" ON "payment_gateways" USING btree ("tenant_id","sort_order","provider");